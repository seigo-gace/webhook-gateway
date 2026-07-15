import type { RouteConfig } from '../part/types.js';

export function getMatchingRoutes(
  routes: RouteConfig[],
  sourceId: string,
  eventType: string
): RouteConfig[] {
  return routes.filter((route) => {
    if (!route.enabled) return false;
    if (route.sourceId !== sourceId) return false;
    if (route.eventTypePattern === '*') return true;
    return route.eventTypePattern === eventType;
  });
}
