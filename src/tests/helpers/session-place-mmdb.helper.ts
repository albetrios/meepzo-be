import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One IPv4 network of a fixture place file and the City-shaped record it answers. */
export interface SessionPlaceFixtureNetwork {
  /** Dotted IPv4 network address, e.g. `203.0.113.0`. */
  network: string;
  /** Prefix length, 1–32. */
  prefixLength: number;
  /** The record, shaped as DB-IP "IP to City Lite" / GeoLite2 City (`city.names.en`, `country.iso_code`). */
  record: Record<string, unknown>;
}

/** MaxMind DB data-section type numbers (MaxMind DB format 2.0). */
const MMDB_TYPE = { UTF8_STRING: 2, UINT32: 6, MAP: 7, ARRAY: 11 } as const;

/** Bytes of one node of a 24-bit-record search tree (two records). */
const NODE_BYTES_FOR_RECORD_SIZE_24 = 6;

/** Zero bytes between the search tree and the data section. */
const DATA_SECTION_SEPARATOR_BYTES = 16;

/** The marker the reader finds the metadata by. */
const METADATA_MARKER = Buffer.concat([
  Buffer.from([0xab, 0xcd, 0xef]),
  Buffer.from('MaxMind.com', 'ascii'),
]);

/** Sizes from this value up use one extra size byte (the format's first size step). */
const ONE_BYTE_SIZE_THRESHOLD = 29;

/** Largest size one extra size byte can carry. */
const ONE_BYTE_SIZE_MAX = ONE_BYTE_SIZE_THRESHOLD + 255;

/** Control byte(s) for a type and a payload size (sizes up to 284 — enough for fixtures). */
function encodeControl({ type, size }: { type: number; size: number }): Buffer {
  if (size > ONE_BYTE_SIZE_MAX)
    throw new Error('fixture values must stay under 285 bytes or entries');
  const sizeBits = Math.min(size, ONE_BYTE_SIZE_THRESHOLD);
  const sizeBytes = size >= ONE_BYTE_SIZE_THRESHOLD ? [size - ONE_BYTE_SIZE_THRESHOLD] : [];
  const head = type <= 7 ? [(type << 5) | sizeBits] : [sizeBits, type - 7];
  return Buffer.from([...head, ...sizeBytes]);
}

/** Encodes a fixture value: strings, non-negative integers (uint32), arrays and plain objects (maps). */
function encodeValue(value: unknown): Buffer {
  if (typeof value === 'string') {
    const payload = Buffer.from(value, 'utf8');
    return Buffer.concat([
      encodeControl({ type: MMDB_TYPE.UTF8_STRING, size: payload.length }),
      payload,
    ]);
  }
  if (typeof value === 'number') {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(value);
    return Buffer.concat([encodeControl({ type: MMDB_TYPE.UINT32, size: 4 }), payload]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      encodeControl({ type: MMDB_TYPE.ARRAY, size: value.length }),
      ...value.map(encodeValue),
    ]);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return Buffer.concat([
      encodeControl({ type: MMDB_TYPE.MAP, size: entries.length }),
      ...entries.flatMap(([key, entry]) => [encodeValue(key), encodeValue(entry)]),
    ]);
  }
  throw new Error(`unsupported fixture value: ${String(value)}`);
}

/** The bits of a dotted IPv4 address, most significant first. */
function ipv4Bits(address: string): number[] {
  const octets = address.split('.').map(Number);
  return octets.flatMap((octet) =>
    Array.from({ length: 8 }, (_, index) => (octet >> (7 - index)) & 1),
  );
}

/** A search-tree record before numbering: another node, a data entry, or nothing. */
type FixtureRecord = { node: number } | { data: number } | null;

/**
 * Builds a tiny IPv4 MaxMind DB (`.mmdb`, format 2.0, 24-bit records) holding the given networks —
 * the same City shape as DB-IP "IP to City Lite" — so tests read a real file through the real
 * reader without downloading or committing the licensed database.
 */
export function buildSessionPlaceMmdb(networks: SessionPlaceFixtureNetwork[]): Buffer {
  const nodes: [FixtureRecord, FixtureRecord][] = [[null, null]];
  networks.forEach((entry, dataIndex) => {
    const bits = ipv4Bits(entry.network).slice(0, entry.prefixLength);
    let nodeIndex = 0;
    bits.forEach((bit, depth) => {
      const isLast = depth === bits.length - 1;
      const node = nodes[nodeIndex]!;
      if (isLast) {
        node[bit] = { data: dataIndex };
        return;
      }
      const next = node[bit];
      if (next && 'node' in next) {
        nodeIndex = next.node;
        return;
      }
      nodes.push([null, null]);
      node[bit] = { node: nodes.length - 1 };
      nodeIndex = nodes.length - 1;
    });
  });

  const encodedRecords = networks.map((entry) => encodeValue(entry.record));
  const dataOffsets: number[] = [];
  encodedRecords.reduce((offset, encoded) => {
    dataOffsets.push(offset);
    return offset + encoded.length;
  }, 0);

  const nodeCount = nodes.length;
  const recordValue = (record: FixtureRecord): number => {
    if (record === null) return nodeCount;
    if ('node' in record) return record.node;
    return nodeCount + DATA_SECTION_SEPARATOR_BYTES + dataOffsets[record.data]!;
  };
  const tree = Buffer.alloc(nodeCount * NODE_BYTES_FOR_RECORD_SIZE_24);
  nodes.forEach(([left, right], index) => {
    tree.writeUIntBE(recordValue(left), index * NODE_BYTES_FOR_RECORD_SIZE_24, 3);
    tree.writeUIntBE(recordValue(right), index * NODE_BYTES_FOR_RECORD_SIZE_24 + 3, 3);
  });

  const metadata = encodeValue({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: 1_700_000_000,
    database_type: 'DBIP-City-Lite',
    description: { en: 'session place fixture' },
    ip_version: 4,
    languages: ['en'],
    node_count: nodeCount,
    record_size: 24,
  });

  return Buffer.concat([
    tree,
    Buffer.alloc(DATA_SECTION_SEPARATOR_BYTES),
    ...encodedRecords,
    METADATA_MARKER,
    metadata,
  ]);
}

/** Writes {@link buildSessionPlaceMmdb}'s file to a fresh temporary directory and returns its path. */
export function writeSessionPlaceMmdb(networks: SessionPlaceFixtureNetwork[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'session-place-'));
  const filePath = join(directory, 'session-place.mmdb');
  writeFileSync(filePath, buildSessionPlaceMmdb(networks));
  return filePath;
}
