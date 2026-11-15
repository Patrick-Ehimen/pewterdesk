import { describe, expect, it } from "vitest";
import { DEFAULT_EMA, type RunSpec } from "../src/lib/backtest";
import {
  type Bot,
  botActions,
  botForRun,
  emptyState,
  PAPER_DAYS,
  startPaper,
  withoutRuns,
  withRun,
} from "../src/lib/bots";

const NOW = Date.UTC(2026, 9, 14, 12);

const bot = (over: Partial<Bot>): Bot => ({
  id: "b",
  kind: "trend",
  venue: "hyperliquid",
  market: "HYPE",
  mode: "paper",
  state: "running",
  sinceStart: 0,
  days: 1,
  ...over,
});

describe("botActions", () => {
  it("goes live only after a full run of paper trading", () => {
    expect(botActions(bot({ paperDay: PAPER_DAYS - 1 })).goLive).toBe(false);
    expect(botActions(bot({ paperDay: PAPER_DAYS })).goLive).toBe(true);
    expect(botActions(bot({ mode: "backtest", paperDay: PAPER_DAYS })).goLive).toBe(false);
  });

  it("starts paper trading from a backtest only", () => {
    expect(botActions(bot({ mode: "backtest", state: "stopped" })).startPaper).toBe(true);
    expect(botActions(bot({ mode: "backtest", state: "stopped" })).start).toBe(false);
    expect(botActions(bot({ mode: "live" })).startPaper).toBe(false);
  });

  it("flattens only a bot that holds a position", () => {
    expect(botActions(bot({})).flatten).toBe(false);
    const position = { side: "long" as const, size: 1, base: "HYPE", entry: 30 };
    expect(botActions(bot({ position })).flatten).toBe(true);
    expect(botActions(bot({ position, state: "stopped" })).flatten).toBe(false);
  });
});

const SPEC: Omit<RunSpec, "id"> = {
  template: "ema",
  ema: DEFAULT_EMA,
  venue: "hyperliquid",
  market: "HYPE",
  interval: "4h",
  bars: 540,
  end: NOW,
  holdOutDays: 30,
  capital: 10_000,
  fee: 0.00045,
  slippageBps: 2,
  seed: 42,
  startPrice: 30,
};

describe("the start", () => {
  it("is empty: no bots, no runs", () => {
    expect(emptyState()).toEqual({ bots: [], runs: [], nextRun: 1 });
  });
});

describe("runs and bots", () => {
  it("gives a new run the next id", () => {
    const [next, run] = withRun(emptyState(), SPEC);
    expect(run.id).toBe(1);
    expect(next.nextRun).toBe(2);
    expect(next.runs).toEqual([run]);
  });

  it("makes one bot per run, as a backtest, and paper trades it from day 1", () => {
    const [withSpec, run] = withRun(emptyState(), SPEC);
    const [withIt, made] = botForRun(withSpec, run, NOW);
    expect(made.mode).toBe("backtest");
    expect(made.run).toBe(run.id);
    expect(withIt.bots[0]).toEqual(made);
    // The same run again returns the same bot.
    const [again, same] = botForRun(withIt, run, NOW);
    expect(again).toBe(withIt);
    expect(same).toEqual(made);

    const paper = startPaper(withIt, made.id, NOW).bots.find((b) => b.id === made.id);
    expect(paper).toMatchObject({ mode: "paper", state: "running", paperDay: 1, sinceStart: 0 });
    expect(paper?.position).toBeUndefined();
  });

  it("names a custom bot after its run", () => {
    const [withSpec, run] = withRun(emptyState(), {
      ...SPEC,
      template: "custom",
      name: "My RSI dip",
      custom: {
        side: "long",
        entry: [
          { left: { kind: "rsi", period: 14 }, op: "below", right: { kind: "value", value: 30 } },
        ],
        exit: [],
        stopLoss: 0.03,
        takeProfit: 0.06,
        size: 1,
      },
    });
    const [, made] = botForRun(withSpec, run, NOW);
    expect(made).toMatchObject({ kind: "custom", name: "My RSI dip" });
  });

  it("deletes runs by id", () => {
    const [state, run] = withRun(emptyState(), SPEC);
    expect(withoutRuns(state, [run.id]).runs).toEqual([]);
  });
});
