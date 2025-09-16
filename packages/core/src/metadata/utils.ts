export interface Metadata {
  title: string;
  titles?: string[];
  year?: number;
  yearEnd?: number;
  seasons?: {
    season_number: number;
    episode_count: number;
  }[];
}
