import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  AIOStreamResponse,
  Env,
  createLogger,
  StremioTransformer,
  Cache,
  IdParser,
} from '@aiostreams/core';
import { stremioStreamRateLimiter } from '../../middlewares/ratelimit.js';

const router: Router = Router();

const logger = createLogger('server');

router.use(stremioStreamRateLimiter);

router.get(
  '/:type/:id.json',
  async (
    req: Request,
    res: Response<AIOStreamResponse>,
    next: NextFunction
  ) => {
    // Check if we have user data (set by middleware in authenticated routes)
    if (!req.userData) {
      // Return a response indicating configuration is needed
      res.status(200).json(
        StremioTransformer.createDynamicError('stream', {
          errorDescription: 'Please configure the addon first',
        })
      );
      return;
    }
    const transformer = new StremioTransformer(req.userData);

    const provideStreamData =
      Env.PROVIDE_STREAM_DATA !== undefined
        ? typeof Env.PROVIDE_STREAM_DATA === 'boolean'
          ? Env.PROVIDE_STREAM_DATA
          : Env.PROVIDE_STREAM_DATA.includes(req.requestIp || '')
        : (req.headers['user-agent']?.includes('AIOStreams/') ?? false);

    try {
      const { type, id } = req.params;

      // Decide whether to disable autoplay (suppress bingeGroup) per user+show
      let disableAutoplay = false;
      if (
        req.userData?.areYouStillThere?.enabled &&
        type === 'series' &&
        req.uuid
      ) {
        const cfg = req.userData.areYouStillThere;
        const threshold = cfg.episodesBeforeCheck ?? 3;
        const cooldownMs = (cfg.cooldownMinutes ?? 60) * 60 * 1000;
        const cache = Cache.getInstance<
          string,
          { count: number; lastAt: number }
        >('areYouStillThere', 10000);
        // Use parsed series identifier (per show) via IdParser to avoid mis-parsing
        const parsed = IdParser.parse(id, type);
        const baseSeriesKey = parsed
          ? `${parsed.type}:${parsed.value}`
          : id.split(':')[0] || id;
        const key = `ays:${req.uuid}:${baseSeriesKey}`;
        const now = Date.now();
        const prev = (await cache.get(key)) || { count: 0, lastAt: 0 };
        const withinWindow = now - prev.lastAt <= cooldownMs;
        const nextCount = withinWindow ? prev.count + 1 : 1;
        if (nextCount >= threshold) {
          // Trigger: disable autoplay for this response and reset counter
          disableAutoplay = true;
          await cache.set(
            key,
            { count: 0, lastAt: now },
            Math.ceil(cooldownMs / 1000)
          );
        } else {
          await cache.set(
            key,
            { count: nextCount, lastAt: now },
            Math.ceil(cooldownMs / 1000)
          );
        }
      }

      res
        .status(200)
        .json(
          await transformer.transformStreams(
            await (
              await new AIOStreams(req.userData).initialise()
            ).getStreams(id, type),
            { provideStreamData, disableAutoplay }
          )
        );
    } catch (error) {
      let errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let errors = [
        {
          description: errorMessage,
        },
      ];
      if (transformer.showError('stream', errors)) {
        logger.error(
          `Unexpected error during stream retrieval: ${errorMessage}`,
          error
        );
        res.status(200).json(
          StremioTransformer.createDynamicError('stream', {
            errorDescription: errorMessage,
          })
        );
        return;
      }
      next(error);
    }
  }
);

export default router;
