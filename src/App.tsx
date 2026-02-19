import { useEffect, useMemo, useState } from 'react';
import { BOSSES, BOSS_BY_NAME } from './data/bosses';
import { CreateTableForm } from './components/CreateTableForm';
import { BossTableCard } from './components/BossTableCard';
import { BackupPanel } from './components/BackupPanel';
import { useNow } from './hooks/useNow';
import type { BossTable, ChannelTimer } from './types';
import { APP_TIME_ZONE } from './utils/time';

const STORAGE_KEY = 'boss-timer/v1';

type StoredState = {
  tables: BossTable[];
};

function makeChannels(count: number): ChannelTimer[] {
  return Array.from({ length: count }, (_, index) => ({
    channel: index + 1,
  }));
}

function makeTableId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadTables(): BossTable[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (!parsed || !Array.isArray(parsed.tables)) return [];
    return parsed.tables;
  } catch {
    return [];
  }
}

export default function App() {
  const [tables, setTables] = useState<BossTable[]>(() => loadTables());
  const now = useNow(1000);

  useEffect(() => {
    const payload: StoredState = { tables };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [tables]);

  const addTable = (bossName: string, channelsCount: number) => {
    const table: BossTable = {
      id: makeTableId(),
      bossName,
      channelsCount,
      channels: makeChannels(channelsCount),
      createdAt: Date.now(),
    };

    setTables((prev) => [table, ...prev]);
  };

  const removeTable = (tableId: string) => {
    setTables((prev) => prev.filter((table) => table.id !== tableId));
  };

  const setChannelsCount = (tableId: string, nextCount: number) => {
    setTables((prev) =>
      prev.map((table) => {
        if (table.id !== tableId) return table;

        const nextChannels =
          nextCount > table.channelsCount
            ? [
                ...table.channels,
                ...Array.from({ length: nextCount - table.channelsCount }, (_, idx) => ({
                  channel: table.channelsCount + idx + 1,
                })),
              ]
            : table.channels.slice(0, nextCount);

        return {
          ...table,
          channelsCount: nextCount,
          channels: nextChannels,
        };
      })
    );
  };

  const markKilled = (tableId: string, channelNumber: number) => {
    const killedAt = Date.now();

    setTables((prev) =>
      prev.map((table) => {
        if (table.id !== tableId) return table;

        const boss = BOSS_BY_NAME.get(table.bossName);
        if (!boss) return table;

        return {
          ...table,
          channels: table.channels.map((channel) => {
            if (channel.channel !== channelNumber) return channel;

            return {
              ...channel,
              killedAt,
              earliestRespawnAt: killedAt + boss.minMs,
              latestRespawnAt: killedAt + boss.maxMs,
            };
          }),
        };
      })
    );
  };

  const clearChannel = (tableId: string, channelNumber: number) => {
    setTables((prev) =>
      prev.map((table) => {
        if (table.id !== tableId) return table;

        return {
          ...table,
          channels: table.channels.map((channel) =>
            channel.channel === channelNumber ? { channel: channelNumber } : channel
          ),
        };
      })
    );
  };

  const replaceTables = (nextTables: BossTable[]) => {
    setTables(nextTables);
  };

  const tableViews = useMemo(() => {
    return tables
      .map((table) => {
        const boss = BOSSES.find((value) => value.name === table.bossName);
        if (!boss) return null;
        return { table, boss };
      })
      .filter((item): item is { table: BossTable; boss: (typeof BOSSES)[number] } => item !== null);
  }, [tables]);

  return (
    <div className="app">
      <header>
        <h1>Boss Timer Tracker</h1>
        <p className="muted">All timestamps are displayed in your local timezone ({APP_TIME_ZONE}).</p>
      </header>

      <BackupPanel tables={tables} onReplaceTables={replaceTables} />

      <CreateTableForm onAddTable={addTable} />

      <main className="tables">
        {tableViews.length === 0 ? (
          <section className="panel muted">No tables yet. Create one above.</section>
        ) : (
          tableViews.map(({ table, boss }) => (
            <BossTableCard
              key={table.id}
              table={table}
              boss={boss}
              now={now}
              onRemoveTable={removeTable}
              onSetChannelsCount={setChannelsCount}
              onKilled={markKilled}
              onClear={clearChannel}
            />
          ))
        )}
      </main>
    </div>
  );
}
