export const COLLECTIONS = {
  users: 'superliga_users_v1',
  predictions: 'superliga_predictions_v1',
  community: 'superliga_community_predictions_v1',
  results: 'superliga_match_results_v1',
  live: 'superliga_live_matches_v1', // legacy/off by default; do not use as hot path
  fixtures: 'superliga_fixture_overrides_v1',
  odds: 'superliga_match_odds_v1',
  elo: 'superliga_team_elo_v1',
  marketValues: 'superliga_team_market_values_v1',
  publicCache: 'superliga_public_cache_v1'
};

export const PUBLIC_CACHE_DOCS = {
  results: 'results',
  fixtures: 'fixtures',
  odds: 'odds',
  elo: 'elo',
  marketValues: 'market-values',
  teamRatings: 'team-ratings',
  community: 'community'
};
