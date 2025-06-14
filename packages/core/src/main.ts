import {
  Addon,
  Manifest,
  Resource,
  StrictManifestResource,
  UserData,
  UserRepository,
} from './db';
import {
  AUDIO_TAGS,
  constants,
  createLogger,
  Env,
  getSimpleTextHash,
  getTimeTakenSincePoint,
  makeRequest,
  StreamType,
  TYPES,
  VISUAL_TAGS,
  TMDBMetadata,
  PossibleRecursiveRequestError,
  decryptString,
  maskSensitiveInfo,
} from './utils';
import { Wrapper } from './wrapper';
import { PresetManager } from './presets';
import {
  AddonCatalog,
  Meta,
  MetaPreview,
  ParsedStream,
  SortCriterion,
  Stream,
  Subtitle,
} from './db/schemas';
import { createProxy } from './proxy';
import { createFormatter } from './formatters';
import {
  compileRegex,
  formRegexFromKeywords,
  parseRegex,
  safeRegexTest,
} from './utils/regex';
import { isMatch } from 'super-regex';
import { ConditionParser } from './parser/conditions';
import { RPDB } from './utils/rpdb';
import { FeatureControl } from './utils/feature';
const logger = createLogger('core');

export interface AIOStreamsError {
  title?: string;
  description?: string;
}

export interface AIOStreamsResponse<T> {
  success: boolean;
  data: T;
  errors: AIOStreamsError[];
}

export class AIOStreams {
  private readonly userData: UserData;
  private manifests: Record<string, Manifest | null>;
  private supportedResources: Record<string, StrictManifestResource[]>;
  private finalResources: StrictManifestResource[] = [];
  private finalCatalogs: Manifest['catalogs'] = [];
  private finalAddonCatalogs: Manifest['addonCatalogs'] = [];
  private isInitialised: boolean = false;
  private addons: Addon[] = [];
  private skipFailedAddons: boolean = true;
  private addonInitialisationErrors: {
    addon: Addon;
    error: string;
  }[] = [];

  constructor(userData: UserData, skipFailedAddons: boolean = true) {
    this.addonInitialisationErrors = [];
    this.userData = userData;
    this.manifests = {};
    this.supportedResources = {};
    this.skipFailedAddons = skipFailedAddons;
  }

  public async initialise(): Promise<AIOStreams> {
    if (this.isInitialised) return this;
    await this.applyPresets();
    await this.assignPublicIps();
    await this.fetchManifests();
    await this.fetchResources();
    this.isInitialised = true;
    return this;
  }

  private checkInitialised() {
    if (!this.isInitialised) {
      throw new Error(
        'AIOStreams is not initialised. Call initialise() first.'
      );
    }
  }

  public async getStreams(
    id: string,
    type: string,
    preCaching: boolean = false
  ): Promise<AIOStreamsResponse<ParsedStream[]>> {
    logger.info(`Handling stream request`, { type, id });

    // step 1
    // get the public IP of the requesting user, using the proxy server if configured
    // if a proxy server is configured, and we fail to get the IP, return an error.
    // however, note that some addons may not be configured to use a proxy,
    // so we should attach an IP to each addon depending on if it would be using the proxy or not.

    // step 2
    // get all parsed stream objects and errors from all addons that have the stream resource.
    // and that support the type and match the id prefix

    const { streams, errors } = await this.getStreamsFromAddons(type, id);

    logger.info(
      `Received ${streams.length} streams and ${errors.length} errors`
    );

    // step 3
    // apply all filters to the streams.

    const filteredStreams = await this.applyFilters(streams, type, id);

    // step 4
    // deduplicate streams based on the depuplicatoroptions

    const deduplicatedStreams = this.deduplicateStreams(filteredStreams);

    // step 5
    // sort the streams based on the sort criteria.

    await this.precomputeSortRegexes(deduplicatedStreams);

    const sortedStreams = this.sortStreams(deduplicatedStreams, type)
      // remove HDR+DV from visual tags after filtering/sorting
      .map((stream) => {
        if (stream.parsedFile?.visualTags?.includes('HDR+DV')) {
          stream.parsedFile.visualTags = stream.parsedFile.visualTags.filter(
            (tag) => tag !== 'HDR+DV'
          );
        }
        return stream;
      });

    // step 6
    // limit the number of streams based on the limit criteria.

    const limitedStreams = this.limitStreams(sortedStreams);

    // step 7
    // proxify streaming links if a proxy is provided

    const proxifiedStreams = this.applyModifications(
      await this.proxifyStreams(limitedStreams)
    );

    // step 8
    // if this.userData.precacheNextEpisode is true, start a new thread to request the next episode, check if
    // all provider streams are uncached, and only if so, then send a request to the first uncached stream in the list.
    if (this.userData.precacheNextEpisode && !preCaching) {
      setImmediate(() => {
        this.precacheNextEpisode(type, id).catch((error) => {
          logger.error('Error during precaching:', {
            error: error instanceof Error ? error.message : String(error),
            type,
            id,
          });
        });
      });
    }

    // step 9
    // return the final list of streams, followed by the error streams.
    logger.info(
      `Returning ${proxifiedStreams.length} streams and ${errors.length} errors`
    );
    return {
      success: true,
      data: proxifiedStreams,
      errors: errors,
    };
  }

  private async precacheNextEpisode(type: string, id: string) {
    const seasonEpisodeRegex = /:(\d+):(\d+)$/;
    const match = id.match(seasonEpisodeRegex);
    if (!match) {
      return;
    }
    const season = match[1];
    const episode = match[2];
    const titleId = id.replace(seasonEpisodeRegex, '');
    const nextEpisodeId = `${titleId}:${season}:${Number(episode) + 1}`;
    logger.info(`Pre-caching next episode of ${titleId}`, {
      season,
      episode,
      nextEpisode: Number(episode) + 1,
      nextEpisodeId,
    });
    const nextStreamsResponse = await this.getStreams(
      nextEpisodeId,
      type,
      true
    );
    if (nextStreamsResponse.success) {
      const nextStreams = nextStreamsResponse.data;
      const serviceStreams = nextStreams.filter((stream) => stream.service);
      if (serviceStreams.every((stream) => stream.service?.cached === false)) {
        const firstUncachedStream = serviceStreams.find(
          (stream) => stream.service?.cached === false
        );
        if (firstUncachedStream && firstUncachedStream.url) {
          try {
            const wrapper = new Wrapper(firstUncachedStream.addon);
            logger.debug(
              `The following stream was selected for precaching:\n${firstUncachedStream.originalDescription}`
            );
            const response = await wrapper.makeRequest(firstUncachedStream.url);
            if (!response.ok) {
              throw new Error(`${response.status} ${response.statusText}`);
            }
            logger.debug(`Response: ${response.status} ${response.statusText}`);
          } catch (error) {
            logger.error(`Error pinging url of first uncached stream`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  public async getCatalog(
    type: string,
    id: string,
    extras?: string
  ): Promise<AIOStreamsResponse<MetaPreview[]>> {
    // step 1
    // get the addon index from the id
    logger.info(`Handling catalog request`, { type, id, extras });
    const start = Date.now();
    const addonInstanceId = id.split('.', 2)[0];
    const addon = this.getAddon(addonInstanceId);
    if (!addon) {
      logger.error(`Addon ${addonInstanceId} not found`);
      return {
        success: false,
        data: [],
        errors: [
          {
            title: `Addon ${addonInstanceId} not found`,
            description: 'Addon not found',
          },
        ],
      };
    }

    // step 2
    // get the actual catalog id from the id
    const actualCatalogId = id.split('.').slice(1).join('.');
    // step 3
    // get the catalog from the addon
    let catalog;
    try {
      catalog = await new Wrapper(addon).getCatalog(
        type,
        actualCatalogId,
        extras
      );
    } catch (error) {
      await this.handlePossibleRecursiveError(error);
      return {
        success: false,
        data: [],
        errors: [
          {
            title: `[❌] ${addon.name}`,
            description: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    logger.info(
      `Received catalog ${actualCatalogId} of type ${type} from ${addon.name} in ${getTimeTakenSincePoint(start)}`
    );

    // apply catalog modifications
    if (this.userData.catalogModifications) {
      const modification = this.userData.catalogModifications.find(
        (mod) => mod.id === id && mod.type === type
      );
      if (modification) {
        if (modification.shuffle && !(extras && extras.includes('search'))) {
          // shuffle the catalog array  if it is not a search
          catalog = catalog.sort(() => Math.random() - 0.5);
        }
        if (modification.rpdb && this.userData.rpdbApiKey) {
          const rpdb = new RPDB(this.userData.rpdbApiKey);
          catalog = catalog.map((item) => {
            const posterUrl = rpdb.getPosterUrl(
              type,
              (item as any).imdb_id || item.id
            );
            if (posterUrl) {
              item.poster = posterUrl;
            }
            return item;
          });
        }
      }
    }

    if (this.userData.enhancePosters) {
      catalog = catalog.map((item) => {
        if (Math.random() < 0.2) {
          item.poster = Buffer.from(
            constants.DEFAULT_POSTERS[
              Math.floor(Math.random() * constants.DEFAULT_POSTERS.length)
            ],
            'base64'
          ).toString('utf-8');
        }
        return item;
      });
    }

    // step 4
    return {
      success: true,
      data: catalog,
      errors: [],
    };
  }

  public async getMeta(
    type: string,
    id: string
  ): Promise<AIOStreamsResponse<Meta | null>> {
    logger.info(`Handling meta request`, { type, id });
    // step 1
    // First try to find an addon that has a matching idPrefix
    for (const [instanceId, resources] of Object.entries(
      this.supportedResources
    )) {
      const resource = resources.find(
        (r) =>
          r.name === 'meta' &&
          r.types.includes(type) &&
          r.idPrefixes?.some((prefix) => id.startsWith(prefix))
      );
      if (resource) {
        const addon = this.getAddon(instanceId);
        if (!addon) {
          continue;
        }
        logger.info(`Found addon with matching id prefix for meta resource`, {
          addonName: addon.name,
          addonInstanceId: instanceId,
        });
        try {
          const meta = await new Wrapper(addon).getMeta(type, id);
          return {
            success: true,
            data: meta,
            errors: [],
          };
        } catch (error) {
          await this.handlePossibleRecursiveError(error);
          logger.error(`Error getting meta from addon ${addon.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false,
            data: null,
            errors: [
              {
                title: `[❌] ${addon.name}`,
                description:
                  error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      }
    }

    // step 2
    // If no matching prefix found, use any addon that supports meta for this type
    for (const [instanceId, resources] of Object.entries(
      this.supportedResources
    )) {
      const resource = resources.find(
        (r) => r.name === 'meta' && r.types.includes(type)
      );
      if (resource) {
        const addon = this.getAddon(instanceId);
        if (!addon) {
          continue;
        }
        logger.info(`Using fallback addon for meta resource`, {
          addonName: addon.name,
          addonInstanceId: instanceId,
        });
        try {
          const meta = await new Wrapper(addon).getMeta(type, id);
          return {
            success: true,
            data: meta,
            errors: [],
          };
        } catch (error) {
          await this.handlePossibleRecursiveError(error);
          logger.error(`Error getting meta from addon ${addon.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false,
            data: null,
            errors: [
              {
                title: `[❌] ${addon.name}`,
                description:
                  error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      }
    }

    logger.error(`No addon found supporting meta resource for type ${type}`);
    throw new Error(`No addon found supporting meta resource for type ${type}`);
  }

  // subtitle resource
  public async getSubtitles(
    type: string,
    id: string,
    extras?: string
  ): Promise<AIOStreamsResponse<Subtitle[]>> {
    logger.info(`getSubtitles: ${id}`);

    // Find all addons that support subtitles for this type and id prefix
    const supportedAddons = [];
    for (const [instanceId, addonResources] of Object.entries(
      this.supportedResources
    )) {
      const resource = addonResources.find(
        (r) =>
          r.name === 'subtitles' &&
          r.types.includes(type) &&
          (r.idPrefixes
            ? r.idPrefixes.some((prefix) => id.startsWith(prefix))
            : true)
      );
      if (resource) {
        const addon = this.getAddon(instanceId);
        if (addon) {
          supportedAddons.push(addon);
        }
      }
    }

    // Request subtitles from all supported addons in parallel
    let errors: AIOStreamsError[] = this.addonInitialisationErrors.map(
      (error) => ({
        title: `[❌] ${error.addon.identifyingName}`,
        description: error.error,
      })
    );
    let allSubtitles: Subtitle[] = [];

    await Promise.all(
      supportedAddons.map(async (addon) => {
        try {
          const subtitles = await new Wrapper(addon).getSubtitles(
            type,
            id,
            extras
          );
          if (subtitles) {
            allSubtitles.push(...subtitles);
          }
        } catch (error) {
          await this.handlePossibleRecursiveError(error);
          errors.push({
            title: `[❌] ${addon.identifyingName}`,
            description: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    return {
      success: true,
      data: allSubtitles,
      errors: errors,
    };
  }

  // addon_catalog resource
  public async getAddonCatalog(
    type: string,
    id: string
  ): Promise<AIOStreamsResponse<AddonCatalog[]>> {
    logger.info(`getAddonCatalog: ${id}`);
    // step 1
    // get the addon instance id from the id
    const addonInstanceId = id.split('.', 2)[0];
    const addon = this.getAddon(addonInstanceId);
    if (!addon) {
      return {
        success: false,
        data: [],
        errors: [
          {
            title: `Addon ${addonInstanceId} not found`,
            description: 'Addon not found',
          },
        ],
      };
    }

    // step 2
    // get the actual addon catalog id from the id
    const actualAddonCatalogId = id.split('.').slice(1).join('.');

    // step 3
    // get the addon catalog from the addon
    let addonCatalogs: AddonCatalog[] = [];
    try {
      addonCatalogs = await new Wrapper(addon).getAddonCatalog(
        type,
        actualAddonCatalogId
      );
    } catch (error) {
      await this.handlePossibleRecursiveError(error);
      return {
        success: false,
        data: [],
        errors: [
          {
            title: `[❌] ${addon.identifyingName}`,
            description: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    // step 4
    return {
      success: true,
      data: addonCatalogs,
      errors: [],
    };
  }
  // converts all addons to
  private async applyPresets() {
    if (!this.userData.presets) {
      return;
    }

    for (const preset of this.userData.presets.filter((p) => p.enabled)) {
      const addons = await PresetManager.fromId(preset.type).generateAddons(
        this.userData,
        preset.options
      );
      this.addons.push(
        ...addons.map((a) => ({
          ...a,
          presetInstanceId: preset.instanceId,
          instanceId: `${preset.instanceId}${getSimpleTextHash(`${a.manifestUrl}`).slice(0, 4)}`,
        }))
      );
    }

    if (this.addons.length > Env.MAX_ADDONS) {
      throw new Error(
        `Your current configuration requires ${this.addons.length} addons, but the maximum allowed is ${Env.MAX_ADDONS}. Please reduce the number of addons, or increase it in the environment variables.`
      );
    }
  }

  private async fetchManifests() {
    this.manifests = Object.fromEntries(
      await Promise.all(
        this.addons.map(async (addon) => {
          try {
            this.validateAddon(addon);
            return [addon.instanceId, await new Wrapper(addon).getManifest()];
          } catch (error: any) {
            await this.handlePossibleRecursiveError(error);
            if (this.skipFailedAddons) {
              this.addonInitialisationErrors.push({
                addon: addon,
                error: error.message,
              });
              logger.error(`${error.message}, skipping`);
              return [addon.instanceId, null];
            }
            throw error;
          }
        })
      )
    );
  }

  private async fetchResources() {
    for (const [instanceId, manifest] of Object.entries(this.manifests)) {
      if (!manifest) continue;

      // Convert string resources to StrictManifestResource objects
      const addonResources = manifest.resources.map((resource) => {
        if (typeof resource === 'string') {
          return {
            name: resource as Resource,
            types: manifest.types,
            idPrefixes: manifest.idPrefixes,
          };
        }
        return resource;
      });

      const addon = this.getAddon(instanceId);

      if (!addon) {
        logger.error(`Addon with instanceId ${instanceId} not found`);
        continue;
      }

      logger.verbose(
        `Determined that ${addon.identifyingName} (Instance ID: ${instanceId}) has support for the following resources: ${JSON.stringify(
          addonResources
        )}`
      );

      // Filter and merge resources
      for (const resource of addonResources) {
        if (
          addon.resources &&
          addon.resources.length > 0 &&
          !addon.resources.includes(resource.name)
        ) {
          continue;
        }

        const existing = this.finalResources.find(
          (r) => r.name === resource.name
        );
        if (existing) {
          existing.types = [...new Set([...existing.types, ...resource.types])];
          if (resource.idPrefixes) {
            existing.idPrefixes = existing.idPrefixes || [];
            existing.idPrefixes = [
              ...new Set([...existing.idPrefixes, ...resource.idPrefixes]),
            ];
          }
        } else {
          this.finalResources.push({
            ...resource,
            idPrefixes: resource.idPrefixes
              ? [...resource.idPrefixes]
              : undefined,
          });
        }
      }

      // Add catalogs with prefixed  IDs (ensure to check that if addon.resources is defined and does not have catalog
      // then we do not add the catalogs)

      if (
        !addon.resources?.length ||
        (addon.resources && addon.resources.includes('catalog'))
      ) {
        this.finalCatalogs.push(
          ...manifest.catalogs.map((catalog) => ({
            ...catalog,
            id: `${addon.instanceId}.${catalog.id}`,
          }))
        );
      }

      // add all addon catalogs, prefixing id with index
      if (manifest.addonCatalogs) {
        this.finalAddonCatalogs!.push(
          ...(manifest.addonCatalogs || []).map((catalog) => ({
            ...catalog,
            id: `${addon.instanceId}.${catalog.id}`,
          }))
        );
      }

      this.supportedResources[instanceId] = addonResources;
    }

    logger.verbose(
      `Parsed all catalogs and determined the following catalogs: ${JSON.stringify(
        this.finalCatalogs.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        }))
      )}`
    );

    logger.verbose(
      `Parsed all addon catalogs and determined the following catalogs: ${JSON.stringify(
        this.finalAddonCatalogs?.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        }))
      )}`
    );

    logger.verbose(
      `Parsed all resources and determined the following resources: ${JSON.stringify(
        this.finalResources.map((r) => ({
          name: r.name,
          types: r.types,
          idPrefixes: r.idPrefixes,
        }))
      )}`
    );

    if (this.userData.catalogModifications) {
      this.finalCatalogs = this.finalCatalogs
        // Sort catalogs based on catalogModifications order, with non-modified catalogs at the end
        .sort((a, b) => {
          const aModIndex = this.userData.catalogModifications!.findIndex(
            (mod) => mod.id === a.id && mod.type === a.type
          );
          const bModIndex = this.userData.catalogModifications!.findIndex(
            (mod) => mod.id === b.id && mod.type === b.type
          );

          // If neither catalog is in modifications, maintain original order
          if (aModIndex === -1 && bModIndex === -1) {
            return (
              this.finalCatalogs.indexOf(a) - this.finalCatalogs.indexOf(b)
            );
          }

          // If only one catalog is in modifications, it should come first
          if (aModIndex === -1) return 1;
          if (bModIndex === -1) return -1;

          // If both are in modifications, sort by their order in modifications
          return aModIndex - bModIndex;
        })
        // filter out any catalogs that are disabled
        .filter((catalog) => {
          const modification = this.userData.catalogModifications!.find(
            (mod) => mod.id === catalog.id && mod.type === catalog.type
          );
          return modification?.enabled !== false; // only if explicity disabled i.e. enabled is true or undefined
        })
        // rename any catalogs if necessary and apply the onlyOnDiscover modification
        .map((catalog) => {
          const modification = this.userData.catalogModifications!.find(
            (mod) => mod.id === catalog.id && mod.type === catalog.type
          );
          if (modification?.name) {
            catalog.name = modification.name;
          }
          if (modification?.onlyOnDiscover) {
            // look in the extra list for a extra with name 'genre', and set 'isRequired' to true
            const genreExtra = catalog.extra?.find((e) => e.name === 'genre');
            if (genreExtra) {
              genreExtra.isRequired = true;
            }
          }
          return catalog;
        });
    }
  }

  public getResources(): StrictManifestResource[] {
    this.checkInitialised();
    return this.finalResources;
  }

  public getCatalogs(): Manifest['catalogs'] {
    this.checkInitialised();
    return this.finalCatalogs;
  }

  public getAddonCatalogs(): Manifest['addonCatalogs'] {
    this.checkInitialised();
    return this.finalAddonCatalogs;
  }

  public getAddon(instanceId: string): Addon | undefined {
    return this.addons.find((a) => a.instanceId === instanceId);
  }

  private shouldProxyStream(stream: ParsedStream): boolean {
    const streamService = stream.service ? stream.service.id : 'none';
    const proxy = this.userData.proxy;
    if (!stream.url || !proxy?.enabled) {
      return false;
    }

    const proxyAddon =
      !proxy.proxiedAddons?.length ||
      proxy.proxiedAddons.includes(stream.addon.presetInstanceId);
    const proxyService =
      !proxy.proxiedServices?.length ||
      proxy.proxiedServices.includes(streamService);

    if (proxy.enabled && proxyAddon && proxyService) {
      return true;
    }

    return false;
  }

  private async getProxyIp() {
    let userIp = this.userData.ip;
    const PRIVATE_IP_REGEX =
      /^(::1|::ffff:(10|127|192|172)\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|192\.168\.(\d{1,3})\.(\d{1,3})|172\.(1[6-9]|2[0-9]|3[0-1])\.(\d{1,3})\.(\d{1,3}))$/;

    if (userIp && PRIVATE_IP_REGEX.test(userIp)) {
      userIp = undefined;
    }
    if (!this.userData.proxy) {
      return userIp;
    }

    const proxy = createProxy(this.userData.proxy);
    if (proxy.getConfig().enabled) {
      userIp = await this.retryGetIp(
        () => proxy.getPublicIp(),
        'Proxy public IP'
      );
    }
    return userIp;
  }

  private async retryGetIp<T>(
    getter: () => Promise<T | null>,
    label: string,
    maxRetries: number = 3
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await getter();
        if (result) {
          return result;
        }
      } catch (error) {
        logger.warn(
          `Failed to get ${label}, retrying... (${attempt}/${maxRetries})`
        );
      }
    }
    throw new Error(`Failed to get ${label} after ${maxRetries} attempts`);
  }
  // stream utility functions
  private async assignPublicIps() {
    let userIp = this.userData.ip;
    let proxyIp = undefined;
    if (this.userData.proxy && this.userData.proxy.enabled) {
      proxyIp = await this.getProxyIp();
    }
    for (const addon of this.addons) {
      const proxy =
        this.userData.proxy &&
        (!this.userData.proxy?.proxiedAddons?.length ||
          this.userData.proxy.proxiedAddons.includes(
            addon.presetInstanceId || ''
          ));
      logger.debug(
        `Using ${proxy ? 'proxy' : 'user'} ip for ${addon.identifyingName}: ${
          proxy
            ? maskSensitiveInfo(proxyIp ?? 'none')
            : maskSensitiveInfo(userIp ?? 'none')
        }`
      );
      if (proxy) {
        addon.ip = proxyIp;
      } else {
        addon.ip = userIp;
      }
    }
  }

  private async getStreamsFromAddons(type: string, id: string) {
    // get a list of all addons that support the stream resource with the given type and id.
    const supportedAddons = [];
    for (const [instanceId, addonResources] of Object.entries(
      this.supportedResources
    )) {
      const resource = addonResources.find(
        (r) =>
          r.name === 'stream' &&
          r.types.includes(type) &&
          (r.idPrefixes
            ? r.idPrefixes?.some((prefix) => id.startsWith(prefix))
            : true) // if no id prefixes are defined, assume it supports all IDs
      );
      if (resource) {
        const addon = this.getAddon(instanceId);
        if (addon) {
          supportedAddons.push(addon);
        }
      }
    }

    logger.info(
      `Found ${supportedAddons.length} addons that support the stream resource`,
      {
        supportedAddons: supportedAddons.map((a) => a.name),
      }
    );

    let errors: AIOStreamsError[] = this.addonInitialisationErrors.map((e) => ({
      title: `[❌] ${e.addon.identifyingName}`,
      description: e.error,
    }));
    let parsedStreams: ParsedStream[] = [];
    let totalTimeTaken = 0;
    let previousGroupStreams: ParsedStream[] = [];
    let previousGroupTimeTaken = 0;

    // Helper function to fetch streams from an addon and log summary
    const fetchFromAddon = async (addon: Addon) => {
      let summaryMsg = '';
      const start = Date.now();
      try {
        this.validateAddon(addon);
        const streams = await new Wrapper(addon).getStreams(type, id);
        // filter out error type streams and put them in errors instead
        const errorStreams = streams.filter(
          (s) => s.type === constants.ERROR_STREAM_TYPE
        );
        if (errorStreams.length > 0) {
          logger.error(
            `Found ${errorStreams.length} error streams from ${addon.identifyingName}`,
            {
              errorStreams: errorStreams.map((s) => s.error?.title),
            }
          );
          errors.push(
            ...errorStreams.map((s) => ({
              title: `[❌] ${s.error?.title || addon.identifyingName}`,
              description: s.error?.description || 'Unknown error',
            }))
          );
        }

        parsedStreams.push(
          ...streams.filter((s) => s.type !== constants.ERROR_STREAM_TYPE)
        );
        // const errorStreams = streams.filter((s) => s.type === constants.ERROR_STREAM_TYPE);
        // parsedStreams.push(...streams.filter((s) => s.type !== constants.ERROR_STREAM_TYPE));
        // errors.push(...errorStreams.map((s) => ({
        //   addon: addon.identifyingName,
        //   error: s.error?.description || 'Unknown error',
        // })));

        summaryMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ${errorStreams.length > 0 ? '🟠' : '🟢'} [${addon.identifyingName}] Scrape Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✔ Status      : ${errorStreams.length > 0 ? 'PARTIAL SUCCESS' : 'SUCCESS'}
  📦 Streams    : ${streams.length}
${errorStreams.length > 0 ? `  ❌ Errors     : ${errorStreams.map((s) => `    • ${s.error?.title || 'Unknown error'}: ${s.error?.description || 'No description'}`).join('\n')}` : ''}
  📋 Details    : ${
    errorStreams.length > 0
      ? `Found errors:\n${errorStreams.map((s) => `    • ${s.error?.title || 'Unknown error'}: ${s.error?.description || 'No description'}`).join('\n')}`
      : 'Successfully fetched streams.'
  }
  ⏱️ Time       : ${getTimeTakenSincePoint(start)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return {
          success: true as const,
          streams,
          timeTaken: Date.now() - start,
        };
      } catch (error) {
        await this.handlePossibleRecursiveError(error);
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          title: `[❌] ${addon.identifyingName}`,
          description: errMsg,
        });
        summaryMsg = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🔴 [${addon.identifyingName}] Scrape Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✖ Status      : FAILED
  🚫 Error      : ${errMsg}
  ⏱️ Time       : ${getTimeTakenSincePoint(start)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return { success: false as const, error: errMsg, timeTaken: 0 };
      } finally {
        logger.info(summaryMsg);
      }
    };

    // Helper function to fetch from a group of addons and track time
    const fetchFromGroup = async (addons: Addon[]) => {
      const groupStart = Date.now();
      const results = await Promise.all(addons.map(fetchFromAddon));
      const groupTime = Date.now() - groupStart;
      return {
        results,
        totalTime: groupTime,
        streams: results.flatMap((r) =>
          r.success ? r.streams : []
        ) as ParsedStream[],
      };
    };

    // If groups are configured, handle group-based fetching
    if (this.userData.groups && this.userData.groups.length > 0) {
      // Always fetch from first group
      const firstGroupAddons = supportedAddons.filter(
        (addon) =>
          addon.presetInstanceId &&
          this.userData.groups![0].addons.includes(addon.presetInstanceId)
      );

      logger.info(
        `Fetching streams from first group with ${firstGroupAddons.length} addons`
      );

      // Fetch streams from first group
      const firstGroupResult = await fetchFromGroup(firstGroupAddons);
      totalTimeTaken = firstGroupResult.totalTime;
      previousGroupStreams = firstGroupResult.streams;
      previousGroupTimeTaken = firstGroupResult.totalTime;

      // For each subsequent group, evaluate condition and fetch if true
      for (let i = 1; i < this.userData.groups.length; i++) {
        const group = this.userData.groups[i];

        // Skip if no condition or addons
        if (!group.condition || !group.addons.length) continue;

        try {
          const parser = new ConditionParser(
            previousGroupStreams,
            parsedStreams,
            previousGroupTimeTaken,
            totalTimeTaken,
            type
          );
          const shouldFetch = await parser.parse(group.condition);
          if (shouldFetch) {
            logger.info(`Condition met for group ${i + 1}, fetching streams`);

            const groupAddons = supportedAddons.filter(
              (addon) =>
                addon.presetInstanceId &&
                group.addons.includes(addon.presetInstanceId)
            );

            const groupResult = await fetchFromGroup(groupAddons);
            totalTimeTaken += groupResult.totalTime;
            previousGroupStreams = groupResult.streams;
            previousGroupTimeTaken = groupResult.totalTime;
          } else {
            logger.info(
              `Condition not met for group ${i + 1}, skipping remaining groups`
            );
            // if we meet a group whose condition is not met, we do not need to fetch from any subsequent groups
            break;
          }
        } catch (error) {
          logger.error(`Error evaluating condition for group ${i}:`, error);
          continue;
        }
      }
    } else {
      // If no groups configured, fetch from all addons in parallel
      const result = await fetchFromGroup(supportedAddons);
      totalTimeTaken = result.totalTime;
    }

    return { streams: parsedStreams, errors };
  }

  private validateAddon(addon: Addon) {
    if (this.userData.uuid && addon.manifestUrl.includes(this.userData.uuid)) {
      logger.warn(
        `${this.userData.uuid} detected to be trying to cause infinite self scraping`
      );
      throw new Error(
        `${addon.identifyingName} appears to be trying to scrape the current user's AIOStreams instance.`
      );
    } else if (
      Env.BASE_URL &&
      new URL(addon.manifestUrl).host === new URL(Env.BASE_URL).host &&
      Env.DISABLE_SELF_SCRAPING === true
    ) {
      throw new Error(
        `Scraping the same AIOStreams instance is disabled. Please use a different AIOStreams instance, or enable it through the environment variables.`
      );
    }
    if (
      addon.presetInstanceId &&
      FeatureControl.disabledAddons.has(addon.presetInstanceId)
    ) {
      throw new Error(
        `Addon ${addon.identifyingName} is disabled: ${FeatureControl.disabledAddons.get(
          addon.presetType
        )}`
      );
    } else if (
      FeatureControl.disabledHosts.has(new URL(addon.manifestUrl).host)
    ) {
      throw new Error(
        `Addon ${addon.identifyingName} is disabled: ${FeatureControl.disabledHosts.get(
          new URL(addon.manifestUrl).host
        )}`
      );
    }
  }

  private async applyFilters(
    streams: ParsedStream[],
    type: string,
    id: string
  ): Promise<ParsedStream[]> {
    interface SkipReason {
      total: number;
      details: Record<string, number>;
    }
    const skipReasons: Record<string, SkipReason> = {
      titleMatching: { total: 0, details: {} },
      seasonEpisodeMatching: { total: 0, details: {} },
      excludedStreamType: { total: 0, details: {} },
      requiredStreamType: { total: 0, details: {} },
      excludedResolution: { total: 0, details: {} },
      requiredResolution: { total: 0, details: {} },
      excludedQuality: { total: 0, details: {} },
      requiredQuality: { total: 0, details: {} },
      excludedEncode: { total: 0, details: {} },
      requiredEncode: { total: 0, details: {} },
      excludedVisualTag: { total: 0, details: {} },
      requiredVisualTag: { total: 0, details: {} },
      excludedAudioTag: { total: 0, details: {} },
      requiredAudioTag: { total: 0, details: {} },
      excludedLanguage: { total: 0, details: {} },
      requiredLanguage: { total: 0, details: {} },
      excludedCached: { total: 0, details: {} },
      requiredCached: { total: 0, details: {} },
      excludedUncached: { total: 0, details: {} },
      requiredUncached: { total: 0, details: {} },
      excludedRegex: { total: 0, details: {} },
      requiredRegex: { total: 0, details: {} },
      excludedKeywords: { total: 0, details: {} },
      requiredKeywords: { total: 0, details: {} },
      requiredSeeders: { total: 0, details: {} },
      excludedSeeders: { total: 0, details: {} },
      size: { total: 0, details: {} },
    };

    const start = Date.now();
    const isRegexAllowed = FeatureControl.isRegexAllowed(this.userData);

    let titles: string[] = [];
    if (this.userData.titleMatching && TYPES.includes(type as any)) {
      try {
        titles = await new TMDBMetadata(
          this.userData.tmdbAccessToken
        ).getTitles(id, type as any);
        logger.info(`Found ${titles.length} titles for ${id}`, { titles });
      } catch (error) {
        logger.error(`Error fetching titles for ${id}: ${error}`);
      }
    }

    const normaliseTitle = (title: string) => {
      return title
        .replace(/[^\p{L}\p{N}+]/gu, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    };

    const performTitleMatch = (stream: ParsedStream) => {
      const titleMatchingOptions = this.userData.titleMatching;
      if (!titleMatchingOptions || !titleMatchingOptions.enabled) {
        return true;
      }
      if (titles.length === 0) {
        // don't filter out streams if no titles could be found
        return true;
      }
      const streamTitle = stream.parsedFile?.title;
      if (!streamTitle) {
        // if a specific stream doesn't have a title, filter it out.
        return false;
      }

      // now check if we need to check this stream based on the addon and request type
      if (
        titleMatchingOptions.requestTypes?.length &&
        !titleMatchingOptions.requestTypes.includes(type)
      ) {
        return true;
      }

      if (
        titleMatchingOptions.addons?.length &&
        !titleMatchingOptions.addons.includes(stream.addon.presetInstanceId)
      ) {
        return true;
      }

      if (titleMatchingOptions.mode === 'exact') {
        // the stream title should be an exact match of a valid title
        return titles.some(
          (title) => normaliseTitle(title) === normaliseTitle(streamTitle)
        );
      } else {
        // a valid title should be present somewhere in the stream title
        const valid = titles.some((title) =>
          normaliseTitle(streamTitle).includes(normaliseTitle(title))
        );
        return valid;
      }
    };

    const performSeasonEpisodeMatch = (stream: ParsedStream) => {
      const seasonEpisodeMatchingOptions = this.userData.seasonEpisodeMatching;
      if (
        !seasonEpisodeMatchingOptions ||
        !seasonEpisodeMatchingOptions.enabled
      ) {
        return true;
      }

      // parse the id to get the season and episode
      const seasonEpisodeRegex = /:(\d+):(\d+)$/;
      const match = id.match(seasonEpisodeRegex);

      if (!match || !match[1] || !match[2]) {
        // only if both season and episode are present, we can filter
        return true;
      }

      const requestedSeason = parseInt(match[1]);
      const requestedEpisode = parseInt(match[2]);

      if (
        seasonEpisodeMatchingOptions.requestTypes?.length &&
        !seasonEpisodeMatchingOptions.requestTypes.includes(type)
      ) {
        return true;
      }

      if (
        seasonEpisodeMatchingOptions.addons?.length &&
        !seasonEpisodeMatchingOptions.addons.includes(
          stream.addon.presetInstanceId
        )
      ) {
        return true;
      }

      // is requested season present
      if (
        requestedSeason &&
        ((stream.parsedFile?.season &&
          stream.parsedFile.season !== requestedSeason) ||
          (stream.parsedFile?.seasons &&
            !stream.parsedFile.seasons.includes(requestedSeason)))
      ) {
        return false;
      }

      // is requested episode present
      if (
        requestedEpisode &&
        stream.parsedFile?.episode &&
        stream.parsedFile.episode !== requestedEpisode
      ) {
        return false;
      }

      return true;
    };

    const excludedRegexPatterns =
      isRegexAllowed &&
      this.userData.excludedRegexPatterns &&
      this.userData.excludedRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.excludedRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const requiredRegexPatterns =
      isRegexAllowed &&
      this.userData.requiredRegexPatterns &&
      this.userData.requiredRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.requiredRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const includedRegexPatterns =
      isRegexAllowed &&
      this.userData.includedRegexPatterns &&
      this.userData.includedRegexPatterns.length > 0
        ? await Promise.all(
            this.userData.includedRegexPatterns.map(
              async (pattern) => await compileRegex(pattern)
            )
          )
        : undefined;

    const excludedKeywordsPattern = this.userData.excludedKeywords
      ? await formRegexFromKeywords(this.userData.excludedKeywords)
      : undefined;

    const requiredKeywordsPattern = this.userData.requiredKeywords
      ? await formRegexFromKeywords(this.userData.requiredKeywords)
      : undefined;

    const includedKeywordsPattern = this.userData.includedKeywords
      ? await formRegexFromKeywords(this.userData.includedKeywords)
      : undefined;

    // test many regexes against many attributes and return true if at least one regex matches any attribute
    // and false if no regex matches any attribute
    const testRegexes = async (stream: ParsedStream, patterns: RegExp[]) => {
      const file = stream.parsedFile;
      const stringsToTest = [
        stream.filename,
        file?.releaseGroup,
        stream.indexer,
        stream.folderName,
      ].filter((v) => v !== undefined);

      for (const string of stringsToTest) {
        for (const pattern of patterns) {
          if (await safeRegexTest(pattern, string)) {
            return true;
          }
        }
      }
      return false;
    };

    const filterBasedOnCacheStatus = (
      stream: ParsedStream,
      mode: 'and' | 'or',
      addonIds: string[] | undefined,
      serviceIds: string[] | undefined,
      streamTypes: StreamType[] | undefined,
      cached: boolean
    ) => {
      const isAddonFilteredOut =
        addonIds &&
        addonIds.length > 0 &&
        addonIds.some((addonId) => stream.addon.presetInstanceId === addonId) &&
        stream.service?.cached === cached;
      const isServiceFilteredOut =
        serviceIds &&
        serviceIds.length > 0 &&
        serviceIds.some((serviceId) => stream.service?.id === serviceId) &&
        stream.service?.cached === cached;
      const isStreamTypeFilteredOut =
        streamTypes &&
        streamTypes.length > 0 &&
        streamTypes.includes(stream.type) &&
        stream.service?.cached === cached;

      if (mode === 'and') {
        return !(
          isAddonFilteredOut &&
          isServiceFilteredOut &&
          isStreamTypeFilteredOut
        );
      } else {
        return !(
          isAddonFilteredOut ||
          isServiceFilteredOut ||
          isStreamTypeFilteredOut
        );
      }
    };

    const normaliseRange = (
      range: [number, number] | undefined,
      defaults: { min: number; max: number }
    ): [number | undefined, number | undefined] | undefined => {
      if (!range) return undefined;
      const [min, max] = range;
      const normMin = min === defaults.min ? undefined : min;
      const normMax = max === defaults.max ? undefined : max;
      return normMin === undefined && normMax === undefined
        ? undefined
        : [normMin, normMax];
    };

    const normaliseSeederRange = (
      seederRange: [number, number] | undefined
    ) => {
      return normaliseRange(seederRange, {
        min: constants.MIN_SEEDERS,
        max: constants.MAX_SEEDERS,
      });
    };

    const normaliseSizeRange = (sizeRange: [number, number] | undefined) => {
      return normaliseRange(sizeRange, {
        min: constants.MIN_SIZE,
        max: constants.MAX_SIZE,
      });
    };

    const getStreamType = (
      stream: ParsedStream
    ): 'p2p' | 'cached' | 'uncached' | undefined => {
      switch (stream.type) {
        case 'debrid':
          return stream.service?.cached ? 'cached' : 'uncached';
        case 'usenet':
          return stream.service?.cached ? 'cached' : 'uncached';
        case 'p2p':
          return 'p2p';
        default:
          return undefined;
      }
    };

    const shouldKeepStream = async (stream: ParsedStream): Promise<boolean> => {
      const file = stream.parsedFile;

      // carry out include checks first
      if (this.userData.includedStreamTypes?.includes(stream.type)) {
        return true;
      }

      if (
        this.userData.includedResolutions?.includes(
          file?.resolution || ('Unknown' as any)
        )
      ) {
        return true;
      }

      if (
        this.userData.includedQualities?.includes(
          file?.quality || ('Unknown' as any)
        )
      ) {
        return true;
      }

      if (
        this.userData.includedVisualTags?.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        return true;
      }

      if (
        this.userData.includedAudioTags?.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        return true;
      }

      if (
        this.userData.includedAudioChannels?.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        return true;
      }

      if (
        this.userData.includedLanguages?.some((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        )
      ) {
        return true;
      }

      if (
        this.userData.includedEncodes?.some(
          (encode) => (file?.encode || 'Unknown') === encode
        )
      ) {
        return true;
      }

      if (
        includedRegexPatterns &&
        (await testRegexes(stream, includedRegexPatterns))
      ) {
        return true;
      }

      if (
        includedKeywordsPattern &&
        (await testRegexes(stream, [includedKeywordsPattern]))
      ) {
        return true;
      }

      const includedSeederRange = normaliseSeederRange(
        this.userData.includeSeederRange
      );
      const excludedSeederRange = normaliseSeederRange(
        this.userData.excludeSeederRange
      );
      const requiredSeederRange = normaliseSeederRange(
        this.userData.requiredSeederRange
      );

      const typeForSeederRange = getStreamType(stream);

      if (
        includedSeederRange &&
        (!this.userData.seederRangeTypes ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          stream.torrent?.seeders &&
          includedSeederRange[0] &&
          stream.torrent.seeders > includedSeederRange[0]
        ) {
          return true;
        }
        if (
          stream.torrent?.seeders &&
          includedSeederRange[1] &&
          stream.torrent.seeders < includedSeederRange[1]
        ) {
          return true;
        }
      }

      if (this.userData.excludedStreamTypes?.includes(stream.type)) {
        // Track stream type exclusions
        skipReasons.excludedStreamType.total++;
        skipReasons.excludedStreamType.details[stream.type] =
          (skipReasons.excludedStreamType.details[stream.type] || 0) + 1;
        return false;
      }

      // Track required stream type misses
      if (
        this.userData.requiredStreamTypes &&
        this.userData.requiredStreamTypes.length > 0 &&
        !this.userData.requiredStreamTypes.includes(stream.type)
      ) {
        skipReasons.requiredStreamType.total++;
        skipReasons.requiredStreamType.details[stream.type] =
          (skipReasons.requiredStreamType.details[stream.type] || 0) + 1;
        return false;
      }

      // Resolutions
      if (
        this.userData.excludedResolutions?.includes(
          (file?.resolution || 'Unknown') as any
        )
      ) {
        skipReasons.excludedResolution.total++;
        skipReasons.excludedResolution.details[file?.resolution || 'Unknown'] =
          (skipReasons.excludedResolution.details[
            file?.resolution || 'Unknown'
          ] || 0) + 1;
        return false;
      }

      if (
        this.userData.requiredResolutions &&
        this.userData.requiredResolutions.length > 0 &&
        !this.userData.requiredResolutions.includes(
          (file?.resolution || 'Unknown') as any
        )
      ) {
        skipReasons.requiredResolution.total++;
        skipReasons.requiredResolution.details[file?.resolution || 'Unknown'] =
          (skipReasons.requiredResolution.details[
            file?.resolution || 'Unknown'
          ] || 0) + 1;
        return false;
      }

      // Qualities
      if (
        this.userData.excludedQualities?.includes(
          (file?.quality || 'Unknown') as any
        )
      ) {
        skipReasons.excludedQuality.total++;
        skipReasons.excludedQuality.details[file?.quality || 'Unknown'] =
          (skipReasons.excludedQuality.details[file?.quality || 'Unknown'] ||
            0) + 1;
        return false;
      }

      if (
        this.userData.requiredQualities &&
        this.userData.requiredQualities.length > 0 &&
        !this.userData.requiredQualities.includes(
          (file?.quality || 'Unknown') as any
        )
      ) {
        skipReasons.requiredQuality.total++;
        skipReasons.requiredQuality.details[file?.quality || 'Unknown'] =
          (skipReasons.requiredQuality.details[file?.quality || 'Unknown'] ||
            0) + 1;
        return false;
      }

      // encode
      if (
        this.userData.excludedEncodes?.includes(
          file?.encode || ('Unknown' as any)
        )
      ) {
        skipReasons.excludedEncode.total++;
        skipReasons.excludedEncode.details[file?.encode || 'Unknown'] =
          (skipReasons.excludedEncode.details[file?.encode || 'Unknown'] || 0) +
          1;
        return false;
      }

      if (
        this.userData.requiredEncodes &&
        this.userData.requiredEncodes.length > 0 &&
        !this.userData.requiredEncodes.includes(
          file?.encode || ('Unknown' as any)
        )
      ) {
        skipReasons.requiredEncode.total++;
        skipReasons.requiredEncode.details[file?.encode || 'Unknown'] =
          (skipReasons.requiredEncode.details[file?.encode || 'Unknown'] || 0) +
          1;
        return false;
      }

      // temporarily add HDR+DV to visual tags list if both HDR and DV are present
      // to allow HDR+DV option in userData to work
      if (
        file?.visualTags?.some((tag) => tag.startsWith('HDR')) &&
        file?.visualTags?.some((tag) => tag.startsWith('DV'))
      ) {
        const hdrIndex = file?.visualTags?.findIndex((tag) =>
          tag.startsWith('HDR')
        );
        const dvIndex = file?.visualTags?.findIndex((tag) =>
          tag.startsWith('DV')
        );
        const insertIndex = Math.min(hdrIndex, dvIndex);
        file?.visualTags?.splice(insertIndex, 0, 'HDR+DV');
      }

      if (
        this.userData.excludedVisualTags?.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        const tag = this.userData.excludedVisualTags.find((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        );
        skipReasons.excludedVisualTag.total++;
        skipReasons.excludedVisualTag.details[tag!] =
          (skipReasons.excludedVisualTag.details[tag!] || 0) + 1;
        return false;
      }

      if (
        this.userData.requiredVisualTags &&
        this.userData.requiredVisualTags.length > 0 &&
        !this.userData.requiredVisualTags.some((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        )
      ) {
        const tag = this.userData.requiredVisualTags.find((tag) =>
          (file?.visualTags.length ? file.visualTags : ['Unknown']).includes(
            tag
          )
        );
        skipReasons.requiredVisualTag.total++;
        skipReasons.requiredVisualTag.details[tag!] =
          (skipReasons.requiredVisualTag.details[tag!] || 0) + 1;
        return false;
      }

      if (
        this.userData.excludedAudioTags?.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        const tag = this.userData.excludedAudioTags.find((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        );
        skipReasons.excludedAudioTag.total++;
        skipReasons.excludedAudioTag.details[tag!] =
          (skipReasons.excludedAudioTag.details[tag!] || 0) + 1;
        return false;
      }

      if (
        this.userData.requiredAudioTags &&
        this.userData.requiredAudioTags.length > 0 &&
        !this.userData.requiredAudioTags.some((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        )
      ) {
        const tag = this.userData.requiredAudioTags.find((tag) =>
          (file?.audioTags.length ? file.audioTags : ['Unknown']).includes(tag)
        );
        skipReasons.requiredAudioTag.total++;
        skipReasons.requiredAudioTag.details[tag!] =
          (skipReasons.requiredAudioTag.details[tag!] || 0) + 1;
        return false;
      }

      if (
        this.userData.excludedAudioChannels?.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        const channel = this.userData.excludedAudioChannels.find((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        );
        skipReasons.excludedAudioChannel.total++;
        skipReasons.excludedAudioChannel.details[channel!] =
          (skipReasons.excludedAudioChannel.details[channel!] || 0) + 1;
        return false;
      }

      if (
        this.userData.requiredAudioChannels &&
        this.userData.requiredAudioChannels.length > 0 &&
        !this.userData.requiredAudioChannels.some((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        )
      ) {
        const channel = this.userData.requiredAudioChannels.find((channel) =>
          (file?.audioChannels.length
            ? file.audioChannels
            : ['Unknown']
          ).includes(channel)
        );
        skipReasons.requiredAudioChannel.total++;
        skipReasons.requiredAudioChannel.details[channel!] =
          (skipReasons.requiredAudioChannel.details[channel!] || 0) + 1;
        return false;
      }

      // languages
      if (
        this.userData.excludedLanguages?.some((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        )
      ) {
        const lang = this.userData.excludedLanguages.find((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        );
        skipReasons.excludedLanguage.total++;
        skipReasons.excludedLanguage.details[lang!] =
          (skipReasons.excludedLanguage.details[lang!] || 0) + 1;
        return false;
      }

      if (
        this.userData.requiredLanguages &&
        this.userData.requiredLanguages.length > 0 &&
        !this.userData.requiredLanguages.some((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        )
      ) {
        const lang = this.userData.requiredLanguages.find((lang) =>
          (file?.languages.length ? file.languages : ['Unknown']).includes(lang)
        );
        skipReasons.requiredLanguage.total++;
        skipReasons.requiredLanguage.details[lang!] =
          (skipReasons.requiredLanguage.details[lang!] || 0) + 1;
        return false;
      }

      // uncached

      if (this.userData.excludeUncached && stream.service?.cached === false) {
        skipReasons.excludedUncached.total++;
        return false;
      }

      if (this.userData.excludeCached && stream.service?.cached === true) {
        skipReasons.excludedCached.total++;
        return false;
      }

      if (
        filterBasedOnCacheStatus(
          stream,
          this.userData.excludeCachedMode || 'or',
          this.userData.excludeCachedFromAddons,
          this.userData.excludeCachedFromServices,
          this.userData.excludeCachedFromStreamTypes,
          true
        ) === false
      ) {
        skipReasons.excludedCached.total++;
        return false;
      }

      if (
        filterBasedOnCacheStatus(
          stream,
          this.userData.excludeUncachedMode || 'or',
          this.userData.excludeUncachedFromAddons,
          this.userData.excludeUncachedFromServices,
          this.userData.excludeUncachedFromStreamTypes,
          false
        ) === false
      ) {
        skipReasons.excludedUncached.total++;
        return false;
      }

      if (
        excludedRegexPatterns &&
        (await testRegexes(stream, excludedRegexPatterns))
      ) {
        skipReasons.excludedRegex.total++;
        return false;
      }
      if (
        requiredRegexPatterns &&
        requiredRegexPatterns.length > 0 &&
        !(await testRegexes(stream, requiredRegexPatterns))
      ) {
        skipReasons.requiredRegex.total++;
        return false;
      }

      if (
        excludedKeywordsPattern &&
        (await testRegexes(stream, [excludedKeywordsPattern]))
      ) {
        skipReasons.excludedKeywords.total++;
        return false;
      }

      if (
        requiredKeywordsPattern &&
        !(await testRegexes(stream, [requiredKeywordsPattern]))
      ) {
        skipReasons.requiredKeywords.total++;
        return false;
      }

      if (
        requiredSeederRange &&
        (!this.userData.seederRangeTypes ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          stream.torrent?.seeders &&
          requiredSeederRange[0] &&
          stream.torrent.seeders < requiredSeederRange[0]
        ) {
          return false;
        }
        if (
          stream.torrent?.seeders &&
          requiredSeederRange[1] &&
          stream.torrent.seeders > requiredSeederRange[1]
        ) {
          return false;
        }
      }

      if (
        excludedSeederRange &&
        (!this.userData.seederRangeTypes ||
          (typeForSeederRange &&
            this.userData.seederRangeTypes.includes(typeForSeederRange)))
      ) {
        if (
          stream.torrent?.seeders &&
          excludedSeederRange[0] &&
          stream.torrent.seeders > excludedSeederRange[0]
        ) {
          return false;
        }
        if (
          stream.torrent?.seeders &&
          excludedSeederRange[1] &&
          stream.torrent.seeders < excludedSeederRange[1]
        ) {
          return false;
        }
      }

      if (!performTitleMatch(stream)) {
        skipReasons.titleMatching.total++;
        skipReasons.titleMatching.details[
          stream.parsedFile?.title || 'Unknown'
        ] =
          (skipReasons.titleMatching.details[
            stream.parsedFile?.title || 'Unknown'
          ] || 0) + 1;
        return false;
      }

      if (!performSeasonEpisodeMatch(stream)) {
        const detail =
          stream.parsedFile?.title +
          ' ' +
          (stream.parsedFile?.seasonEpisode?.join(' x ') || 'Unknown');

        skipReasons.seasonEpisodeMatching.total++;
        skipReasons.seasonEpisodeMatching.details[detail] =
          (skipReasons.seasonEpisodeMatching.details[detail] || 0) + 1;
        return false;
      }

      const global = this.userData.size?.global;
      const resolution = stream.parsedFile?.resolution
        ? this.userData.size?.resolution?.[
            stream.parsedFile
              .resolution as keyof typeof this.userData.size.resolution
          ]
        : undefined;

      let minMax: [number | undefined, number | undefined] | undefined;
      if (type === 'movie') {
        minMax =
          normaliseSizeRange(resolution?.movies) ||
          normaliseSizeRange(global?.movies);
      } else {
        minMax =
          normaliseSizeRange(resolution?.series) ||
          normaliseSizeRange(global?.series);
      }

      if (minMax) {
        if (stream.size && minMax[0] && stream.size < minMax[0]) {
          skipReasons.size.total++;
          return false;
        }
        if (stream.size && minMax[1] && stream.size > minMax[1]) {
          skipReasons.size.total++;
          return false;
        }
      }

      return true;
    };

    const filterResults = await Promise.all(streams.map(shouldKeepStream));
    const filteredStreams = streams.filter((_, index) => filterResults[index]);

    // Log filter summary
    const totalFiltered = streams.length - filteredStreams.length;
    if (totalFiltered > 0) {
      const summary = [
        '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `  🔍 Filter Summary`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `  📊 Total Streams : ${streams.length}`,
        `  ✔️ Kept         : ${filteredStreams.length}`,
        `  ❌ Filtered     : ${totalFiltered}`,
      ];

      // Add filter details if any streams were filtered
      const filterDetails: string[] = [];
      for (const [reason, stats] of Object.entries(skipReasons)) {
        if (stats.total > 0) {
          // Convert camelCase to Title Case with spaces
          const formattedReason = reason
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (str) => str.toUpperCase());

          filterDetails.push(`\n  📌 ${formattedReason} (${stats.total})`);
          for (const [detail, count] of Object.entries(stats.details)) {
            filterDetails.push(`    • ${count}× ${detail}`);
          }
        }
      }

      if (filterDetails.length > 0) {
        summary.push('\n  🔎 Filter Details:');
        summary.push(...filterDetails);
      }

      summary.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info(summary.join('\n'));
    }

    logger.info(`Applied filters in ${getTimeTakenSincePoint(start)}`);
    return filteredStreams;
  }

  private deduplicateStreams(streams: ParsedStream[]): ParsedStream[] {
    let deduplicator = this.userData.deduplicator;
    if (!deduplicator || !deduplicator.enabled) {
      return streams;
    }
    const start = Date.now();

    const deduplicationKeys = deduplicator.keys || ['filename', 'infoHash'];

    deduplicator = {
      enabled: true,
      keys: deduplicationKeys,
      cached: deduplicator.cached || 'per_addon',
      uncached: deduplicator.uncached || 'per_addon',
      p2p: deduplicator.p2p || 'per_addon',
      http: deduplicator.http || 'disabled',
      live: deduplicator.live || 'disabled',
      youtube: deduplicator.youtube || 'disabled',
      external: deduplicator.external || 'disabled',
    };

    // Group streams by their deduplication keys
    const streamGroups = new Map<string, ParsedStream[]>();

    for (const stream of streams) {
      // Create a unique key based on the selected deduplication methods
      const keys: string[] = [];

      if (deduplicationKeys.includes('filename') && stream.filename) {
        let normalisedFilename = stream.filename
          .replace(
            /(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|3gp|3g2|m2ts|ts|vob|ogv|ogm|divx|xvid|rm|rmvb|asf|mxf|mka|mks|mk3d|webm|f4v|f4p|f4a|f4b)$/i,
            ''
          )
          .replace(/[^\p{L}\p{N}+]/gu, '')
          .replace(/\s+/g, '')
          .toLowerCase();
        keys.push(`filename:${normalisedFilename}`);
      }

      if (deduplicationKeys.includes('infoHash') && stream.torrent?.infoHash) {
        keys.push(`infoHash:${stream.torrent.infoHash}`);
      }

      if (deduplicationKeys.includes('smartDetect')) {
        // generate a hash using many different attributes
        // round size to nearest 100MB for some margin of error
        const roundedSize = stream.size
          ? Math.round(stream.size / 100000000) * 100000000
          : undefined;
        const hash = getSimpleTextHash(
          `${roundedSize}${stream.parsedFile?.resolution}${stream.parsedFile?.quality}${stream.parsedFile?.visualTags}${stream.parsedFile?.audioTags}${stream.parsedFile?.languages}${stream.parsedFile?.encode}`
        );
        keys.push(`smartDetect:${hash}`);
      }

      // If no keys match, keep the stream
      if (keys.length === 0) {
        streamGroups.set(`unique_${Math.random()}`, [stream]);
        continue;
      }

      // Add stream to all matching key groups
      for (const key of keys) {
        const group = streamGroups.get(key) || [];
        group.push(stream);
        streamGroups.set(key, group);
      }
    }

    // Process each group based on stream types and deduplication modes
    const processedStreams = new Set<ParsedStream>();

    for (const group of streamGroups.values()) {
      // Group streams by type
      const streamsByType = new Map<string, ParsedStream[]>();
      for (const stream of group) {
        let type = stream.type as string;
        if ((type === 'debrid' || type === 'usenet') && stream.service) {
          type = stream.service.cached ? 'cached' : 'uncached';
        }
        const typeGroup = streamsByType.get(type) || [];
        typeGroup.push(stream);
        streamsByType.set(type, typeGroup);
      }

      // Process each type according to its deduplication mode
      for (const [type, typeStreams] of streamsByType.entries()) {
        const mode = deduplicator[type as keyof typeof deduplicator] as string;
        if (mode === 'disabled') {
          typeStreams.forEach((stream) => processedStreams.add(stream));
          continue;
        }

        switch (mode) {
          case 'single_result': {
            // Keep one result with highest priority service and addon
            let selectedStream = typeStreams.sort((a, b) => {
              // so a specific type may either have both streams not have a service, or both streams have a service
              // if both streams have a service, then we can simpl
              const aProviderIndex =
                this.userData.services?.findIndex(
                  (service) => service.id === a.service?.id
                ) ?? -1;
              const bProviderIndex =
                this.userData.services?.findIndex(
                  (service) => service.id === b.service?.id
                ) ?? -1;

              if (
                aProviderIndex &&
                bProviderIndex &&
                aProviderIndex !== bProviderIndex
              ) {
                return aProviderIndex - bProviderIndex;
              }

              // look at seeders for p2p and uncached streams
              if (
                (type === 'p2p' || type === 'uncached') &&
                a.torrent?.seeders &&
                b.torrent?.seeders
              ) {
                return (b.torrent.seeders || 0) - (a.torrent.seeders || 0);
              }

              // now look at the addon index

              const aAddonIndex =
                this.userData.presets.findIndex(
                  (preset) => preset.instanceId === a.addon.presetInstanceId
                ) ?? -1;
              const bAddonIndex =
                this.userData.presets.findIndex(
                  (preset) => preset.instanceId === b.addon.presetInstanceId
                ) ?? -1;

              // the addon index MUST exist, its not possible for it to not exist
              if (aAddonIndex !== bAddonIndex) {
                return aAddonIndex - bAddonIndex;
              }

              // now look at stream type
              const aTypeIndex =
                this.userData.preferredStreamTypes?.findIndex(
                  (type) => type === a.type
                ) ?? 0;
              const bTypeIndex =
                this.userData.preferredStreamTypes?.findIndex(
                  (type) => type === b.type
                ) ?? 0;

              if (aTypeIndex !== bTypeIndex) {
                return aTypeIndex - bTypeIndex;
              }

              return 0;
            })[0];
            processedStreams.add(selectedStream);
            break;
          }
          case 'per_service': {
            // Keep one result from each service (highest priority available addon for that service)
            // first, ensure that all streams have a service, otherwise we can't use this mode
            if (typeStreams.some((stream) => !stream.service)) {
              throw new Error(
                'per_service mode requires all streams to have a service'
              );
            }
            let perServiceStreams = Object.values(
              typeStreams.reduce(
                (acc, stream) => {
                  acc[stream.service!.id] = acc[stream.service!.id] || [];
                  acc[stream.service!.id].push(stream);
                  return acc;
                },
                {} as Record<string, ParsedStream[]>
              )
            ).map((serviceStreams) => {
              return serviceStreams.sort((a, b) => {
                const aAddonIndex =
                  this.userData.presets.findIndex(
                    (preset) => preset.instanceId === a.addon.presetInstanceId
                  ) ?? -1;
                const bAddonIndex =
                  this.userData.presets.findIndex(
                    (preset) => preset.instanceId === b.addon.presetInstanceId
                  ) ?? -1;
                if (aAddonIndex !== bAddonIndex) {
                  return aAddonIndex - bAddonIndex;
                }

                // now look at stream type
                const aTypeIndex =
                  this.userData.preferredStreamTypes?.findIndex(
                    (type) => type === a.type
                  ) ?? 0;
                const bTypeIndex =
                  this.userData.preferredStreamTypes?.findIndex(
                    (type) => type === b.type
                  ) ?? 0;
                if (aTypeIndex !== bTypeIndex) {
                  return aTypeIndex - bTypeIndex;
                }

                // look at seeders for p2p and uncached streams
                if (type === 'p2p' || type === 'uncached') {
                  return (b.torrent?.seeders || 0) - (a.torrent?.seeders || 0);
                }
                return 0;
              })[0];
            });
            for (const stream of perServiceStreams) {
              processedStreams.add(stream);
            }
            break;
          }
          case 'per_addon': {
            if (typeStreams.some((stream) => !stream.addon)) {
              throw new Error(
                'per_addon mode requires all streams to have an addon'
              );
            }
            let perAddonStreams = Object.values(
              typeStreams.reduce(
                (acc, stream) => {
                  acc[stream.addon.presetInstanceId] =
                    acc[stream.addon.presetInstanceId] || [];
                  acc[stream.addon.presetInstanceId].push(stream);
                  return acc;
                },
                {} as Record<string, ParsedStream[]>
              )
            ).map((addonStreams) => {
              return addonStreams.sort((a, b) => {
                const aServiceIndex =
                  this.userData.services?.findIndex(
                    (service) => service.id === a.service?.id
                  ) ?? -1;
                const bServiceIndex =
                  this.userData.services?.findIndex(
                    (service) => service.id === b.service?.id
                  ) ?? -1;
                if (aServiceIndex !== bServiceIndex) {
                  return aServiceIndex - bServiceIndex;
                }

                // look at seeders for p2p and uncached streams
                if (type === 'p2p' || type === 'uncached') {
                  return (b.torrent?.seeders || 0) - (a.torrent?.seeders || 0);
                }
                return 0;
              })[0];
            });
            for (const stream of perAddonStreams) {
              processedStreams.add(stream);
            }
            break;
          }
        }
      }
    }

    let deduplicatedStreams = Array.from(processedStreams);
    logger.info(
      `Filtered out ${streams.length - deduplicatedStreams.length} duplicate streams to ${deduplicatedStreams.length} streams in ${getTimeTakenSincePoint(start)}`
    );
    return deduplicatedStreams;
  }

  private async precomputeSortRegexes(streams: ParsedStream[]) {
    const preferredRegexPatterns =
      FeatureControl.isRegexAllowed(this.userData) &&
      this.userData.preferredRegexPatterns
        ? await Promise.all(
            this.userData.preferredRegexPatterns.map(async (pattern) => {
              return {
                name: pattern.name,
                negate: parseRegex(pattern.pattern).flags.includes('n'),
                pattern: await compileRegex(pattern.pattern),
              };
            })
          )
        : undefined;
    const preferredKeywordsPatterns = this.userData.preferredKeywords
      ? await formRegexFromKeywords(this.userData.preferredKeywords)
      : undefined;
    if (!preferredRegexPatterns && !preferredKeywordsPatterns) {
      return;
    }
    const start = Date.now();
    if (preferredKeywordsPatterns) {
      streams.forEach((stream) => {
        stream.keywordMatched =
          isMatch(preferredKeywordsPatterns, stream.filename || '') ||
          isMatch(preferredKeywordsPatterns, stream.folderName || '') ||
          isMatch(
            preferredKeywordsPatterns,
            stream.parsedFile?.releaseGroup || ''
          ) ||
          isMatch(preferredKeywordsPatterns, stream.indexer || '');
      });
    }
    const determineMatch = (
      stream: ParsedStream,
      regexPattern: { pattern: RegExp; negate: boolean },
      attribute?: string
    ) => {
      if (regexPattern.negate) {
        return attribute ? !isMatch(regexPattern.pattern, attribute) : true;
      }
      return attribute ? isMatch(regexPattern.pattern, attribute) : false;
    };
    if (preferredRegexPatterns) {
      streams.forEach((stream) => {
        for (let i = 0; i < preferredRegexPatterns.length; i++) {
          // if negate, then the pattern must not match any of the attributes
          // and if the attribute is undefined, then we can consider that as a non-match so true
          const regexPattern = preferredRegexPatterns[i];
          const filenameMatch = determineMatch(
            stream,
            regexPattern,
            stream.filename
          );
          const folderNameMatch = determineMatch(
            stream,
            regexPattern,
            stream.folderName
          );
          const releaseGroupMatch = determineMatch(
            stream,
            regexPattern,
            stream.parsedFile?.releaseGroup
          );
          const indexerMatch = determineMatch(
            stream,
            regexPattern,
            stream.indexer
          );
          let match =
            filenameMatch ||
            folderNameMatch ||
            releaseGroupMatch ||
            indexerMatch;
          if (match) {
            stream.regexMatched = {
              name: regexPattern.name,
              pattern: regexPattern.pattern.source,
              index: i,
            };
            break;
          }
        }
      });
    }
    logger.info(`Precomputed sort regexes in ${getTimeTakenSincePoint(start)}`);
  }

  private sortStreams(streams: ParsedStream[], type: string): ParsedStream[] {
    let primarySortCriteria = this.userData.sortCriteria.global;
    let cachedSortCriteria = this.userData.sortCriteria.cached;
    let uncachedSortCriteria = this.userData.sortCriteria.uncached;

    const start = Date.now();

    if (type === 'movie') {
      if (this.userData.sortCriteria?.movies?.length) {
        primarySortCriteria = this.userData.sortCriteria?.movies;
      }
      if (this.userData.sortCriteria?.cachedMovies?.length) {
        cachedSortCriteria = this.userData.sortCriteria?.cachedMovies;
      }
      if (this.userData.sortCriteria?.uncachedMovies?.length) {
        uncachedSortCriteria = this.userData.sortCriteria?.uncachedMovies;
      }
    }

    if (type === 'series') {
      if (this.userData.sortCriteria?.series?.length) {
        primarySortCriteria = this.userData.sortCriteria?.series;
      }
      if (this.userData.sortCriteria?.cachedSeries?.length) {
        cachedSortCriteria = this.userData.sortCriteria?.cachedSeries;
      }
      if (this.userData.sortCriteria?.uncachedSeries?.length) {
        uncachedSortCriteria = this.userData.sortCriteria?.uncachedSeries;
      }
    }

    if (type === 'anime') {
      if (this.userData.sortCriteria?.anime?.length) {
        primarySortCriteria = this.userData.sortCriteria?.anime;
      }
      if (this.userData.sortCriteria?.cachedAnime?.length) {
        cachedSortCriteria = this.userData.sortCriteria?.cachedAnime;
      }
      if (this.userData.sortCriteria?.uncachedAnime?.length) {
        uncachedSortCriteria = this.userData.sortCriteria?.uncachedAnime;
      }
    }

    let sortedStreams = [];

    if (
      cachedSortCriteria?.length &&
      uncachedSortCriteria?.length &&
      primarySortCriteria.length > 0 &&
      primarySortCriteria[0].key === 'cached'
    ) {
      logger.info(
        'Splitting streams into cached and uncached and using separate sort criteria'
      );
      const cachedStreams = streams.filter(
        (stream) => stream.service?.cached || stream.service === undefined // streams without a service can be considered as 'cached'
      );
      const uncachedStreams = streams.filter(
        (stream) => stream.service?.cached === false
      );

      // sort the 2 lists separately, and put them after the other, depending on the direction of cached
      const cachedSorted = cachedStreams.slice().sort((a, b) => {
        const aKey = this.dynamicSortKey(a, cachedSortCriteria, type);
        const bKey = this.dynamicSortKey(b, cachedSortCriteria, type);
        for (let i = 0; i < aKey.length; i++) {
          if (aKey[i] < bKey[i]) return -1;
          if (aKey[i] > bKey[i]) return 1;
        }
        return 0;
      });

      const uncachedSorted = uncachedStreams.slice().sort((a, b) => {
        const aKey = this.dynamicSortKey(a, uncachedSortCriteria, type);
        const bKey = this.dynamicSortKey(b, uncachedSortCriteria, type);
        for (let i = 0; i < aKey.length; i++) {
          if (aKey[i] < bKey[i]) return -1;
          if (aKey[i] > bKey[i]) return 1;
        }
        return 0;
      });

      if (primarySortCriteria[0].direction === 'desc') {
        sortedStreams = [...cachedSorted, ...uncachedSorted];
      } else {
        sortedStreams = [...uncachedSorted, ...cachedSorted];
      }
    } else {
      logger.debug(
        `using sort criteria: ${JSON.stringify(primarySortCriteria)}`
      );
      sortedStreams = streams.slice().sort((a, b) => {
        const aKey = this.dynamicSortKey(a, primarySortCriteria, type);
        const bKey = this.dynamicSortKey(b, primarySortCriteria, type);

        for (let i = 0; i < aKey.length; i++) {
          if (aKey[i] < bKey[i]) return -1;
          if (aKey[i] > bKey[i]) return 1;
        }
        return 0;
      });
    }

    logger.info(
      `Sorted ${sortedStreams.length} streams in ${getTimeTakenSincePoint(start)}`
    );
    return sortedStreams;
  }

  private dynamicSortKey(
    stream: ParsedStream,
    sortCriteria: SortCriterion[],
    type: string
  ): any[] {
    function keyValue(sortCriterion: SortCriterion, userData: UserData) {
      const { key, direction } = sortCriterion;
      const multiplier = direction === 'asc' ? 1 : -1;
      switch (key) {
        case 'cached':
          return multiplier * (stream.service?.cached !== false ? 1 : 0);

        case 'library':
          return multiplier * (stream.library ? 1 : 0);
        case 'size':
          return multiplier * (stream.size ?? 0);
        case 'seeders':
          return multiplier * (stream.torrent?.seeders ?? 0);
        case 'encode': {
          const index = userData.preferredEncodes?.findIndex(
            (encode) => encode === (stream.parsedFile?.encode || 'Unknown')
          );
          return multiplier * -(index === -1 ? 0 : (index ?? 0));
        }
        case 'addon':
          // find the first occurence of the stream.addon.id in the addons array
          const idx = userData.presets.findIndex(
            (p) => p.instanceId === stream.addon.presetInstanceId
          );
          return multiplier * (idx !== -1 ? -idx : 0);

        case 'resolution': {
          const index = userData.preferredResolutions?.findIndex(
            (resolution) =>
              resolution === (stream.parsedFile?.resolution || 'Unknown')
          );
          return multiplier * -(index === -1 ? 0 : (index ?? 0));
        }
        case 'quality': {
          const index = userData.preferredQualities?.findIndex(
            (quality) => quality === (stream.parsedFile?.quality || 'Unknown')
          );
          return multiplier * -(index === -1 ? 0 : (index ?? 0));
        }
        case 'visualTag': {
          let minIndex = userData.preferredVisualTags?.length;
          if (minIndex === undefined) {
            return 0;
          }
          if (!stream.parsedFile) {
            return 0;
          }
          for (const tag of stream.parsedFile?.visualTags || []) {
            if (VISUAL_TAGS.includes(tag as any)) {
              const idx = userData.preferredVisualTags?.indexOf(tag as any);
              if (idx !== undefined && idx !== -1 && idx < minIndex) {
                minIndex = idx;
              }
            }
          }
          return multiplier * -minIndex;
        }
        case 'audioTag': {
          let minAudioIndex = userData.preferredAudioTags?.length;
          if (minAudioIndex === undefined) {
            return 0;
          }
          if (!stream.parsedFile) {
            return 0;
          }
          for (const tag of stream.parsedFile.audioTags) {
            if (AUDIO_TAGS.includes(tag as any)) {
              const idx = userData.preferredAudioTags?.indexOf(tag as any);
              if (idx !== undefined && idx !== -1 && idx < minAudioIndex) {
                minAudioIndex = idx;
              }
            }
          }
          return multiplier * -minAudioIndex;
        }
        case 'streamType': {
          const index = userData.preferredStreamTypes?.findIndex(
            (type) => type === stream.type
          );
          return multiplier * -(index === -1 ? 0 : (index ?? 0));
        }
        case 'language': {
          let minLanguageIndex = userData.preferredLanguages?.length;
          if (minLanguageIndex === undefined) {
            return 0;
          }
          for (const language of stream.parsedFile?.languages || ['Unknown']) {
            const idx = userData.preferredLanguages?.indexOf(language as any);
            if (idx !== undefined && idx !== -1 && idx < minLanguageIndex) {
              minLanguageIndex = idx;
            }
          }
          return multiplier * -minLanguageIndex;
        }
        case 'regexPatterns':
          return (
            multiplier *
            -(stream.regexMatched ? stream.regexMatched.index : Infinity)
          );

        // return (
        //   multiplier *
        //   (stream.regexMatched ? -stream.regexMatched.index : -Infinity)
        // );
        // return multiplier * -(stream.regexMatched?.index ?? 0);

        case 'keyword':
          return multiplier * (stream.keywordMatched ? 1 : 0);

        case 'service': {
          const index = userData.services?.findIndex(
            (service) => service.id === stream.service?.id
          );
          return multiplier * -(index === -1 ? 0 : (index ?? 0));
        }
        default:
          return 0;
      }
    }

    return (
      sortCriteria.map((sortCriterion) =>
        keyValue(sortCriterion, this.userData)
      ) ?? []
    );
  }

  private applyModifications(streams: ParsedStream[]): ParsedStream[] {
    if (this.userData.randomiseResults) {
      streams.sort(() => Math.random() - 0.5);
    }
    if (this.userData.enhanceResults) {
      streams.forEach((stream) => {
        if (Math.random() < 0.4) {
          stream.filename = undefined;
          stream.parsedFile = undefined;
          stream.type = 'youtube';
          stream.ytId = Buffer.from(constants.DEFAULT_YT_ID, 'base64').toString(
            'utf-8'
          );
          stream.message =
            'This stream has been artificially enhanced using the best AI on the market.';
        }
      });
    }
    return streams;
  }

  private limitStreams(streams: ParsedStream[]): ParsedStream[] {
    if (!this.userData.resultLimits) {
      return streams;
    }

    // these are our limits
    const {
      indexer,
      releaseGroup,
      resolution,
      quality,
      global,
      addon,
      streamType,
      service,
    } = this.userData.resultLimits;

    const start = Date.now();

    // Track counts for each category
    const counts = {
      indexer: new Map<string, number>(),
      releaseGroup: new Map<string, number>(),
      resolution: new Map<string, number>(),
      quality: new Map<string, number>(),
      addon: new Map<string, number>(),
      streamType: new Map<string, number>(),
      service: new Map<string, number>(),
      global: 0,
    };

    // Keep track of which indexes to remove
    const indexesToRemove = new Set<number>();

    // Process each stream and check against limits
    streams.forEach((stream, index) => {
      // Skip if already marked for removal
      if (indexesToRemove.has(index)) return;

      // Check global limit first
      if (global && counts.global >= global) {
        indexesToRemove.add(index);
        return;
      }

      // Check indexer limit
      if (indexer && stream.indexer) {
        const count = counts.indexer.get(stream.indexer) || 0;
        if (count >= indexer) {
          indexesToRemove.add(index);
          return;
        }
        counts.indexer.set(stream.indexer, count + 1);
      }

      // Check release group limit
      if (releaseGroup && stream.parsedFile?.releaseGroup) {
        const count =
          counts.releaseGroup.get(stream.parsedFile?.releaseGroup || '') || 0;
        if (count >= releaseGroup) {
          indexesToRemove.add(index);
          return;
        }
        counts.releaseGroup.set(stream.parsedFile.releaseGroup, count + 1);
      }

      // Check resolution limit
      if (resolution) {
        const count =
          counts.resolution.get(stream.parsedFile?.resolution || 'Unknown') ||
          0;
        if (count >= resolution) {
          indexesToRemove.add(index);
          return;
        }
        counts.resolution.set(
          stream.parsedFile?.resolution || 'Unknown',
          count + 1
        );
      }

      // Check quality limit
      if (quality) {
        const count =
          counts.quality.get(stream.parsedFile?.quality || 'Unknown') || 0;
        if (count >= quality) {
          indexesToRemove.add(index);
          return;
        }
        counts.quality.set(stream.parsedFile?.quality || 'Unknown', count + 1);
      }

      // Check addon limit
      if (addon) {
        const count = counts.addon.get(stream.addon.presetInstanceId) || 0;
        if (count >= addon) {
          indexesToRemove.add(index);
          return;
        }
        counts.addon.set(stream.addon.presetInstanceId, count + 1);
      }

      // Check stream type limit
      if (streamType && stream.type) {
        const count = counts.streamType.get(stream.type) || 0;
        if (count >= streamType) {
          indexesToRemove.add(index);
          return;
        }
        counts.streamType.set(stream.type, count + 1);
      }

      // Check service limit
      if (service && stream.service?.id) {
        const count = counts.service.get(stream.service.id) || 0;
        if (count >= service) {
          indexesToRemove.add(index);
          return;
        }
        counts.service.set(stream.service.id, count + 1);
      }

      // If we got here, increment global count
      counts.global++;
    });

    // Filter out the streams that exceeded limits
    const limitedStreams = streams.filter(
      (_, index) => !indexesToRemove.has(index)
    );

    // Log summary of removed streams
    const removedCount = streams.length - limitedStreams.length;
    if (removedCount > 0) {
      logger.info(
        `Removed ${removedCount} streams due to limits in ${getTimeTakenSincePoint(start)}`
      );
    }

    return limitedStreams;
  }

  private async handlePossibleRecursiveError(error: any) {
    if (error instanceof PossibleRecursiveRequestError) {
      if (this.userData.uuid && this.userData.encryptedPassword) {
        const newData = {
          ...this.userData,
          presets: [],
        };
        const password = decryptString(this.userData.encryptedPassword).data;
        if (password) {
          logger.warn(
            `resetting addons of user ${this.userData.uuid} due to possible recursive request`
          );
          await UserRepository.updateUser(
            this.userData.uuid,
            password,
            newData
          );
        }
      }
    }
  }

  private async proxifyStreams(
    streams: ParsedStream[]
  ): Promise<ParsedStream[]> {
    if (!this.userData.proxy?.enabled) {
      return streams;
    }

    const streamsToProxy = streams
      .map((stream, index) => ({ stream, index }))
      .filter(({ stream }) => stream.url && this.shouldProxyStream(stream));

    if (streamsToProxy.length === 0) {
      return streams;
    }
    logger.info(`Proxying ${streamsToProxy.length} streams`);

    const proxy = createProxy(this.userData.proxy);

    const proxiedUrls = streamsToProxy.length
      ? await proxy.generateUrls(
          streamsToProxy.map(({ stream }) => ({
            url: stream.url!,
            filename: stream.filename,
            headers: {
              request: stream.requestHeaders,
              response: stream.responseHeaders,
            },
          }))
        )
      : [];

    logger.info(`Generated ${(proxiedUrls || []).length} proxied URLs`);

    const removeIndexes = new Set<number>();

    streamsToProxy.forEach(({ stream, index }, i) => {
      const proxiedUrl = proxiedUrls?.[i];
      if (proxiedUrl) {
        stream.url = proxiedUrl;
        stream.proxied = true;
      } else {
        removeIndexes.add(index);
      }
    });

    if (removeIndexes.size > 0) {
      logger.warn(
        `Failed to proxy ${removeIndexes.size} streams. Removing them from the list.`
      );
      streams = streams.filter((_, index) => !removeIndexes.has(index));
    }

    return streams;
  }
}
