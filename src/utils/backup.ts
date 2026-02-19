import type { BossTable, ChannelTimer } from '../types';
import { APP_TIME_ZONE } from './time';

export const BACKUP_PREFIX = 'BOSSTIMER_V1:';
export const BACKUP_PREFIX_GZ = 'BOSSTIMER_V2GZ:';
export const BACKUP_VERSION = 1;
export const STORAGE_VERSION = 'boss-timer/v1';

const MIN_CHANNELS = 1;
const MAX_CHANNELS = 50;

type UnknownRecord = Record<string, unknown>;

export type ExportPayload = {
  version: number;
  storageVersion: string;
  exportedAt: number;
  timezone: string;
  tables: BossTable[];
};

export type ImportResult = {
  payload: ExportPayload;
  warnings: string[];
};

export type ConflictChoice = 'mine' | 'theirs';

export type MergeConflict = {
  id: string;
  bossName: string;
  tableId: string;
  channel: number;
  mine: ChannelTimer;
  theirs: ChannelTimer;
};

export type MergePreview = {
  mergedTables: BossTable[];
  conflicts: MergeConflict[];
  defaultChoices: Record<string, ConflictChoice>;
};

function clampChannelsCount(value: number): number {
  return Math.max(MIN_CHANNELS, Math.min(MAX_CHANNELS, Math.floor(value)));
}

function toEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function hasTimer(channel?: ChannelTimer): boolean {
  return Boolean(
    channel &&
      (typeof channel.killedAt === 'number' ||
        typeof channel.earliestRespawnAt === 'number' ||
        typeof channel.latestRespawnAt === 'number')
  );
}

function timerSignature(channel: ChannelTimer): string {
  return [channel.killedAt ?? '', channel.earliestRespawnAt ?? '', channel.latestRespawnAt ?? ''].join('|');
}

function cloneChannel(channel: ChannelTimer): ChannelTimer {
  return {
    channel: channel.channel,
    killedAt: channel.killedAt,
    earliestRespawnAt: channel.earliestRespawnAt,
    latestRespawnAt: channel.latestRespawnAt,
  };
}

function cloneTable(table: BossTable): BossTable {
  return {
    ...table,
    channels: table.channels.map(cloneChannel),
  };
}

function generateTableId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ensureUniqueId(existingIds: Set<string>, preferredId: string): string {
  if (!existingIds.has(preferredId)) {
    existingIds.add(preferredId);
    return preferredId;
  }

  let nextId = generateTableId();
  while (existingIds.has(nextId)) {
    nextId = generateTableId();
  }
  existingIds.add(nextId);
  return nextId;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}

export function decodeBase64(base64: string): string {
  const bytes = base64ToBytes(base64);
  return new TextDecoder().decode(bytes);
}

async function gzipText(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;

  const inputStream = new Blob([text]).stream();
  const compressedStream = inputStream.pipeThrough(new CompressionStream('gzip'));
  const arrayBuffer = await new Response(compressedStream).arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

async function gunzipBytes(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Invalid backup string');
  }

  const safeBytes = new Uint8Array(bytes.byteLength);
  safeBytes.set(bytes);
  const inputStream = new Blob([safeBytes]).stream();
  const decompressedStream = inputStream.pipeThrough(new DecompressionStream('gzip'));
  const arrayBuffer = await new Response(decompressedStream).arrayBuffer();
  return new TextDecoder().decode(new Uint8Array(arrayBuffer));
}

export async function exportState(tables: BossTable[]): Promise<string> {
  const payload: ExportPayload = {
    version: BACKUP_VERSION,
    storageVersion: STORAGE_VERSION,
    exportedAt: Date.now(),
    timezone: APP_TIME_ZONE,
    tables,
  };

  const json = JSON.stringify(payload);
  const compressed = await gzipText(json);

  if (compressed && compressed.length > 0) {
    return `${BACKUP_PREFIX_GZ}${bytesToBase64(compressed)}`;
  }

  return `${BACKUP_PREFIX}${encodeBase64(json)}`;
}

function normalizeChannel(channel: unknown): ChannelTimer | null {
  if (!isObject(channel)) return null;
  const rawChannel = channel.channel;
  if (typeof rawChannel !== 'number' || !Number.isFinite(rawChannel)) return null;

  const channelNumber = Math.max(1, Math.floor(rawChannel));

  return {
    channel: channelNumber,
    killedAt: toEpoch(channel.killedAt),
    earliestRespawnAt: toEpoch(channel.earliestRespawnAt),
    latestRespawnAt: toEpoch(channel.latestRespawnAt),
  };
}

function normalizeTable(table: unknown, index: number, warnings: string[]): BossTable | null {
  if (!isObject(table)) {
    warnings.push(`Skipped table #${index + 1}: not an object.`);
    return null;
  }

  if (typeof table.bossName !== 'string' || table.bossName.trim().length === 0) {
    warnings.push(`Skipped table #${index + 1}: missing bossName.`);
    return null;
  }

  const parsedChannels = Array.isArray(table.channels)
    ? table.channels.map(normalizeChannel).filter((value): value is ChannelTimer => value !== null)
    : [];

  const deduped = new Map<number, ChannelTimer>();
  for (const channel of parsedChannels) {
    deduped.set(channel.channel, channel);
  }

  const uniqueChannels = Array.from(deduped.values()).sort((a, b) => a.channel - b.channel);
  const maxChannel = uniqueChannels.length === 0 ? 0 : uniqueChannels[uniqueChannels.length - 1].channel;

  let requestedCount = MIN_CHANNELS;
  if (typeof table.channelsCount === 'number' && Number.isFinite(table.channelsCount)) {
    requestedCount = Math.floor(table.channelsCount);
  } else if (maxChannel > 0) {
    requestedCount = maxChannel;
  }

  const channelsCount = clampChannelsCount(Math.max(requestedCount, maxChannel));

  if (typeof table.channelsCount === 'number' && Number.isFinite(table.channelsCount)) {
    const clampedOriginal = clampChannelsCount(table.channelsCount);
    if (clampedOriginal !== table.channelsCount) {
      warnings.push(`Table "${table.bossName}": channelsCount was clamped to ${clampedOriginal}.`);
    }
  }

  if (channelsCount !== uniqueChannels.length) {
    warnings.push(
      `Table "${table.bossName}": channels rebuilt (${uniqueChannels.length} -> ${channelsCount}) to match count.`
    );
  }

  const byChannel = new Map(uniqueChannels.map((channel) => [channel.channel, channel]));
  const channels: ChannelTimer[] = Array.from({ length: channelsCount }, (_, idx) => {
    const channelNumber = idx + 1;
    return byChannel.get(channelNumber) ?? { channel: channelNumber };
  });

  return {
    id: typeof table.id === 'string' && table.id.length > 0 ? table.id : `imported-${Date.now()}-${index}`,
    bossName: table.bossName,
    channelsCount,
    channels,
    createdAt: toEpoch(table.createdAt) ?? Date.now(),
  };
}

export async function importState(input: string): Promise<ImportResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Invalid backup string');
  }

  let jsonText = trimmed;

  if (trimmed.startsWith(BACKUP_PREFIX_GZ)) {
    const encoded = trimmed.slice(BACKUP_PREFIX_GZ.length);
    try {
      jsonText = await gunzipBytes(base64ToBytes(encoded));
    } catch {
      throw new Error('Invalid backup string');
    }
  } else if (trimmed.startsWith(BACKUP_PREFIX)) {
    const encoded = trimmed.slice(BACKUP_PREFIX.length);
    try {
      jsonText = decodeBase64(encoded);
    } catch {
      throw new Error('Invalid backup string');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Invalid backup string');
  }

  if (!isObject(parsed)) {
    throw new Error('Invalid backup string');
  }

  if (parsed.version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup version');
  }

  if (!Array.isArray(parsed.tables)) {
    throw new Error('Invalid backup string');
  }

  const warnings: string[] = [];
  if (parsed.timezone !== APP_TIME_ZONE) {
    warnings.push(`Backup timezone is "${String(parsed.timezone)}", your timezone is "${APP_TIME_ZONE}".`);
  }

  const tables = parsed.tables
    .map((table, index) => normalizeTable(table, index, warnings))
    .filter((table): table is BossTable => table !== null);

  const payload: ExportPayload = {
    version: BACKUP_VERSION,
    storageVersion:
      typeof parsed.storageVersion === 'string' && parsed.storageVersion.length > 0
        ? parsed.storageVersion
        : STORAGE_VERSION,
    exportedAt: toEpoch(parsed.exportedAt) ?? Date.now(),
    timezone: typeof parsed.timezone === 'string' ? parsed.timezone : APP_TIME_ZONE,
    tables,
  };

  return { payload, warnings };
}

export function buildMergePreview(existingTables: BossTable[], importedTables: BossTable[]): MergePreview {
  const mergedTables = existingTables.map(cloneTable);
  const conflicts: MergeConflict[] = [];
  const defaultChoices: Record<string, ConflictChoice> = {};

  const usedIds = new Set(mergedTables.map((table) => table.id));

  for (const importedTable of importedTables.map(cloneTable)) {
    const targetIndex = mergedTables.findIndex((table) => table.bossName === importedTable.bossName);

    if (targetIndex < 0) {
      const uniqueId = ensureUniqueId(usedIds, importedTable.id);
      mergedTables.push({ ...importedTable, id: uniqueId });
      continue;
    }

    const existing = mergedTables[targetIndex];
    const mergedCount = clampChannelsCount(Math.max(existing.channelsCount, importedTable.channelsCount));

    const mineByChannel = new Map(existing.channels.map((channel) => [channel.channel, channel]));
    const theirsByChannel = new Map(importedTable.channels.map((channel) => [channel.channel, channel]));

    const nextChannels: ChannelTimer[] = [];

    for (let channelNumber = 1; channelNumber <= mergedCount; channelNumber += 1) {
      const mine = mineByChannel.get(channelNumber) ?? { channel: channelNumber };
      const theirs = theirsByChannel.get(channelNumber) ?? { channel: channelNumber };

      const mineHas = hasTimer(mine);
      const theirsHas = hasTimer(theirs);

      if (!mineHas && theirsHas) {
        nextChannels.push(cloneChannel(theirs));
        continue;
      }

      if (mineHas && !theirsHas) {
        nextChannels.push(cloneChannel(mine));
        continue;
      }

      if (!mineHas && !theirsHas) {
        nextChannels.push({ channel: channelNumber });
        continue;
      }

      if (timerSignature(mine) === timerSignature(theirs)) {
        nextChannels.push(cloneChannel(mine));
        continue;
      }

      const conflictId = `${existing.id}:${channelNumber}:${conflicts.length}`;
      conflicts.push({
        id: conflictId,
        bossName: existing.bossName,
        tableId: existing.id,
        channel: channelNumber,
        mine: cloneChannel(mine),
        theirs: cloneChannel(theirs),
      });
      defaultChoices[conflictId] = 'mine';
      nextChannels.push(cloneChannel(mine));
    }

    mergedTables[targetIndex] = {
      ...existing,
      channelsCount: mergedCount,
      channels: nextChannels,
    };
  }

  return { mergedTables, conflicts, defaultChoices };
}

export function applyMergeChoices(
  preview: MergePreview,
  choices: Record<string, ConflictChoice>
): BossTable[] {
  const result = preview.mergedTables.map(cloneTable);
  const tableIndexById = new Map(result.map((table, index) => [table.id, index]));

  for (const conflict of preview.conflicts) {
    const selected = choices[conflict.id] ?? 'mine';
    const idx = tableIndexById.get(conflict.tableId);
    if (idx === undefined) continue;

    const table = result[idx];
    const channelIdx = table.channels.findIndex((channel) => channel.channel === conflict.channel);
    if (channelIdx < 0) continue;

    table.channels[channelIdx] = selected === 'theirs' ? cloneChannel(conflict.theirs) : cloneChannel(conflict.mine);
  }

  return result;
}
