import { Env } from '../../utils/env.js';
import pLimit from 'p-limit';

export const createQueryLimit = () =>
  pLimit(Env.BUILTIN_SCRAPE_QUERY_CONCURRENCY);

export function calculateAbsoluteEpisode(
  season: string,
  episode: string,
  seasons: { number: string; episodes: number }[]
): string {
  const episodeNumber = Number(episode);
  let totalEpisodesBeforeSeason = 0;

  for (const s of seasons.filter((s) => s.number !== '0')) {
    if (s.number === season) break;
    totalEpisodesBeforeSeason += s.episodes;
  }

  return (totalEpisodesBeforeSeason + episodeNumber).toString();
}

/**
 * Determines whether to use all titles for scraping based on the environment variable.
 *
 * Env.BUILTIN_SCRAPE_WITH_ALL_TITLES can be:
 *   - an array: in which case, if the hostname of the given URL is in the array, returns true.
 *   - a boolean: returns its truthiness.
 *   - undefined: returns false.
 *
 * @param url - The URL whose hostname is checked against the array (if applicable).
 * @returns {boolean} - True if all titles should be used for the given URL, false otherwise.
 */
export function useAllTitles(url: string): boolean {
  if (Array.isArray(Env.BUILTIN_SCRAPE_WITH_ALL_TITLES)) {
    return Env.BUILTIN_SCRAPE_WITH_ALL_TITLES.includes(new URL(url).hostname);
  }
  return !!Env.BUILTIN_SCRAPE_WITH_ALL_TITLES;
}
