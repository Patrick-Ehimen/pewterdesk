import { useCallback, useEffect, useRef, useState } from "react";
import { CloudError, type CloudStatus, cloudClient } from "../api/cloudClient";
import {
  type AccountKey,
  addDays,
  type JournalDay,
  newDay,
  normalizeDay,
  normalizeNote,
  normalizePlan,
  normalizePlaybook,
  type Plan,
  type Playbook,
  type TradeNote,
  utcDay,
} from "../lib/journal";

/** Runs `jobs` a few at a time, in order of starting. */
async function inBatches<T>(items: readonly T[], job: (item: T) => Promise<unknown>, size = 6) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(job));
}

/** How far back the journal reads: the review's longest range. */
export const JOURNAL_DAYS = 90;

export type CloudAuth =
  | { state: "loading" }
  | { state: "unavailable"; error: string }
  | { state: "notConfigured" }
  | { state: "signedOut" }
  | { state: "signedIn"; email: string };

/** Who is signed in to PewterDesk Cloud, and the ways in and out. */
export function useCloudAuth(enabled: boolean) {
  const [auth, setAuth] = useState<CloudAuth>({ state: "loading" });
  const read = useCallback(() => {
    cloudClient.status().then(
      (s: CloudStatus) =>
        setAuth(
          !s.configured
            ? { state: "notConfigured" }
            : s.email !== null
              ? { state: "signedIn", email: s.email }
              : { state: "signedOut" },
        ),
      (e: unknown) => setAuth({ state: "unavailable", error: (e as Error).message }),
    );
  }, []);
  useEffect(() => {
    if (enabled) read();
  }, [enabled, read]);

  const verify = useCallback(async (email: string, code: string) => {
    const signedIn = await cloudClient.verify(email, code);
    setAuth({ state: "signedIn", email: signedIn });
  }, []);
  const signOut = useCallback(async () => {
    await cloudClient.signOut();
    setAuth({ state: "signedOut" });
  }, []);
  /** The session ended under us (a call came back signed out). */
  const lost = useCallback(() => setAuth({ state: "signedOut" }), []);
  return { auth, read, sendCode: cloudClient.sendCode, verify, signOut, lost };
}

export interface Stored<T> {
  id?: string;
  data: T;
}

export interface JournalData {
  plan?: Stored<Plan>;
  playbooks: Map<string, Playbook>;
  days: Map<string, Stored<JournalDay>>;
  /** By trade key. */
  notes: Map<string, Stored<TradeNote>>;
}

export type Load = { state: "loading" } | { state: "ready" } | { state: "error"; error: string };

/**
 * The account's plan and journal, and the trader's playbooks, read from the
 * cloud while `signedIn`, and written back one record at a time. Writes show
 * at once; one that fails is reported, and the next read puts back what the
 * cloud holds.
 */
export function useJournal(
  account: AccountKey | undefined,
  signedIn: boolean,
  onSignedOut: () => void,
) {
  const [data, setData] = useState<JournalData>({
    playbooks: new Map(),
    days: new Map(),
    notes: new Map(),
  });
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(0);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const signedOutRef = useRef(onSignedOut);
  signedOutRef.current = onSignedOut;
  const dataRef = useRef(data);
  dataRef.current = data;
  /** Cleared days and when, kept apart so a draft written before the clear can't undo it. */
  const cleared = useRef(new Map<string, number>());

  const failed = useCallback((e: unknown) => {
    if (e instanceof CloudError && e.signedOut) signedOutRef.current();
    return e instanceof Error ? e.message : String(e);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the reload trigger
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setLoad({ state: "loading" });
    const from = addDays(utcDay(Date.now()), -JOURNAL_DAYS);
    const query = account ? { accountKey: account, from } : undefined;
    Promise.all([
      account ? cloudClient.list<unknown>("plans", { accountKey: account }) : Promise.resolve([]),
      cloudClient.list<unknown>("playbooks"),
      query ? cloudClient.list<unknown>("journalDays", query) : Promise.resolve([]),
      query ? cloudClient.list<unknown>("tradeNotes", query) : Promise.resolve([]),
    ]).then(
      ([plans, playbooks, days, notes]) => {
        if (!live) return;
        const next: JournalData = { playbooks: new Map(), days: new Map(), notes: new Map() };
        if (plans[0]) next.plan = { id: plans[0].id, data: normalizePlan(plans[0].data) };
        for (const p of playbooks) if (p.id) next.playbooks.set(p.id, normalizePlaybook(p.data));
        cleared.current = new Map();
        for (const d of days)
          if (d.day) {
            const entry = normalizeDay(d.data);
            next.days.set(d.day, { id: d.id, data: entry });
            if (entry.clearedAt !== undefined) cleared.current.set(d.day, entry.clearedAt);
          }
        for (const n of notes) {
          const note = n.tradeKey ? normalizeNote(n.data) : undefined;
          if (note && n.tradeKey) next.notes.set(n.tradeKey, { id: n.id, data: note });
        }
        setData(next);
        setLoad({ state: "ready" });
      },
      (e: unknown) => live && setLoad({ state: "error", error: failed(e) }),
    );
    return () => {
      live = false;
    };
  }, [account, signedIn, tick, failed]);

  const write = useCallback(
    async (job: () => Promise<void>) => {
      setSaving((n) => n + 1);
      try {
        await job();
        setSaveError(undefined);
      } catch (e) {
        setSaveError(failed(e));
        throw e;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [failed],
  );

  const savePlan = useCallback(
    (plan: Plan) => {
      if (!account) return Promise.resolve();
      setData((d) => ({ ...d, plan: { id: d.plan?.id, data: plan } }));
      return write(async () => {
        const saved = await cloudClient.put("plans", { accountKey: account, data: plan });
        // Only the id: an edit made while this was on its way stays.
        setData((d) => ({ ...d, plan: { id: saved.id, data: d.plan?.data ?? plan } }));
      });
    },
    [account, write],
  );

  /**
   * Deletes the account's trading plan from the cloud, every version of it
   * (one row holds them). Playbooks, journal days and trade notes stay.
   */
  const planId = data.plan?.id;
  const removePlan = useCallback(() => {
    const id = planId;
    setData((d) => ({ ...d, plan: undefined }));
    return write(async () => {
      if (id) await cloudClient.remove("plans", id);
    });
  }, [planId, write]);

  const savePlaybook = useCallback(
    (id: string, playbook: Playbook) => {
      setData((d) => ({ ...d, playbooks: new Map(d.playbooks).set(id, playbook) }));
      return write(async () => {
        await cloudClient.put("playbooks", { id, data: playbook });
      });
    },
    [write],
  );

  const removePlaybook = useCallback(
    (id: string) => {
      setData((d) => {
        const playbooks = new Map(d.playbooks);
        playbooks.delete(id);
        return { ...d, playbooks };
      });
      return write(() => cloudClient.remove("playbooks", id));
    },
    [write],
  );

  const saveDay = useCallback(
    (day: string, entry: JournalDay) => {
      if (!account) return Promise.resolve();
      // A draft from before the day was cleared: dropped, not written over the clear.
      if (cleared.current.has(day) && entry.clearedAt === undefined) return Promise.resolve();
      setData((d) => ({
        ...d,
        days: new Map(d.days).set(day, { id: d.days.get(day)?.id, data: entry }),
      }));
      return write(async () => {
        const saved = await cloudClient.put("journalDays", {
          accountKey: account,
          day,
          data: entry,
        });
        setData((d) => ({
          ...d,
          days: new Map(d.days).set(day, { id: saved.id, data: d.days.get(day)?.data ?? entry }),
        }));
      });
    },
    [account, write],
  );

  const saveNote = useCallback(
    (key: string, note: TradeNote) => {
      if (!account) return Promise.resolve();
      const clearedAt = cleared.current.get(utcDay(note.trade.closedAt));
      if (clearedAt !== undefined && note.trade.closedAt <= clearedAt) return Promise.resolve();
      setData((d) => ({
        ...d,
        notes: new Map(d.notes).set(key, { id: d.notes.get(key)?.id, data: note }),
      }));
      return write(async () => {
        const saved = await cloudClient.put("tradeNotes", {
          accountKey: account,
          tradeKey: key,
          day: utcDay(note.trade.closedAt),
          playbookId: note.playbookId,
          data: note,
        });
        setData((d) => ({
          ...d,
          notes: new Map(d.notes).set(key, { id: saved.id, data: d.notes.get(key)?.data ?? note }),
        }));
      });
    },
    [account, write],
  );

  /** Removes one trade note (an open trade's, once its closed trade has it). */
  const removeNote = useCallback(
    (key: string) => {
      const id = data.notes.get(key)?.id;
      setData((d) => {
        const notes = new Map(d.notes);
        notes.delete(key);
        return { ...d, notes };
      });
      return write(async () => {
        if (id) await cloudClient.remove("tradeNotes", id);
      });
    },
    [data.notes, write],
  );

  /**
   * Clears days from the journal, in PewterDesk only: their entries, trade
   * notes and screenshots are deleted from the cloud, and each day is kept as
   * cleared, so the venue's trades closed by now are hidden here. The venue's
   * own history is untouched.
   */
  const clearDays = useCallback(
    async (list: readonly string[]) => {
      if (!account || list.length === 0) return;
      const at = Date.now();
      const set = new Set(list);
      for (const day of list) cleared.current.set(day, at);
      const snapshot = dataRef.current;
      const notes = [...snapshot.notes].filter(([, n]) => set.has(utcDay(n.data.trade.closedAt)));
      const files = [
        ...notes.flatMap(([, n]) => n.data.attachments),
        ...list.flatMap((day) => snapshot.days.get(day)?.data.attachments ?? []),
      ];
      const blank: JournalDay = { ...newDay(), clearedAt: at };
      setData((d) => {
        const days = new Map(d.days);
        for (const day of list) days.set(day, { id: d.days.get(day)?.id, data: blank });
        const kept = new Map(d.notes);
        for (const [key] of notes) kept.delete(key);
        return { ...d, days, notes: kept };
      });
      await write(async () => {
        await inBatches(notes, ([, n]) =>
          n.id ? cloudClient.remove("tradeNotes", n.id) : Promise.resolve(),
        );
        await inBatches(list, async (day) => {
          const saved = await cloudClient.put("journalDays", {
            accountKey: account,
            day,
            data: blank,
          });
          setData((d) => ({
            ...d,
            days: new Map(d.days).set(day, { id: saved.id, data: d.days.get(day)?.data ?? blank }),
          }));
        });
        // A screenshot that won't go is only an orphan file in the trader's own folder.
        await inBatches(files, (path) => cloudClient.removeAttachment(path).catch(() => {}));
      });
    },
    [account, write],
  );

  /** Shows cleared days' trades again. What was deleted with them stays deleted. */
  const restoreDays = useCallback(
    async (list: readonly string[]) => {
      if (!account || list.length === 0) return;
      const entries = list.map((day) => {
        cleared.current.delete(day);
        const { clearedAt: _, ...rest } = dataRef.current.days.get(day)?.data ?? newDay();
        return [day, rest as JournalDay] as const;
      });
      setData((d) => {
        const days = new Map(d.days);
        for (const [day, entry] of entries) days.set(day, { id: d.days.get(day)?.id, data: entry });
        return { ...d, days };
      });
      await write(() =>
        inBatches(entries, ([day, data]) =>
          cloudClient.put("journalDays", { accountKey: account, day, data }),
        ),
      );
    },
    [account, write],
  );

  return {
    data,
    load,
    clearDays,
    restoreDays,
    saving: saving > 0,
    saveError,
    reload,
    savePlan,
    removePlan,
    savePlaybook,
    removePlaybook,
    saveDay,
    saveNote,
    removeNote,
  };
}

export type Journal = ReturnType<typeof useJournal>;

/**
 * Calls `save` with the latest value once it has stopped changing for `delay`
 * ms, and on unmount if a change is still waiting.
 */
export function useAutosave<T>(value: T, save: (value: T) => void, delay = 1200, dirty = true) {
  const latest = useRef({ value, save, pending: false });
  latest.current.value = value;
  latest.current.save = save;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new value restarts the wait
  useEffect(() => {
    if (!dirty) return;
    latest.current.pending = true;
    const id = setTimeout(() => {
      latest.current.pending = false;
      latest.current.save(latest.current.value);
    }, delay);
    return () => clearTimeout(id);
  }, [value, delay, dirty]);
  useEffect(
    () => () => {
      if (latest.current.pending) latest.current.save(latest.current.value);
    },
    [],
  );
}
