import { describe, expect, it } from 'vitest';
import { collectRouteSchemaMetadata } from '@tooling/openapi/extractors/route-schema-metadata.js';
import { MCP_OPENAPI_RESOURCE_URI } from '@/shared/constants/project-identity.constants.js';

describe('route-schema-metadata', () => {
  const metadata = collectRouteSchemaMetadata();

  it('reads a description past its escaped quotes — none is cut short', () => {
    for (const [routeKey, entry] of metadata) {
      expect(entry.description ?? '', routeKey).not.toMatch(/\\$/);
      expect(entry.description ?? '', routeKey).not.toMatch(/\\['"`]/);
    }
  });

  it('fills a template description from the string constants it names', () => {
    for (const [routeKey, entry] of metadata) {
      expect(entry.description ?? '', routeKey).not.toContain('${');
    }
    // An imported constant
    expect(metadata.get('GET /api/v1/mcp')?.description).toContain(MCP_OPENAPI_RESOURCE_URI);
  });
});
