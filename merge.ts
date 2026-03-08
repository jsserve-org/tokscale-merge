import type {
  TokenContributionData,
  DailyContribution,
  SourceContribution,
  TokenBreakdown,
  YearSummary,
} from "./types.ts";

function addBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

function zeroBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function totalTokens(bd: TokenBreakdown): number {
  return bd.input + bd.output + bd.cacheRead + bd.cacheWrite + bd.reasoning;
}

/**
 * Merge contributions from multiple devices into a single unified payload.
 * Days are merged by date; within a day, source contributions are merged
 * by (client, modelId, providerId) key — summing all numeric fields.
 */
export function mergeContributions(
  datasets: TokenContributionData[]
): TokenContributionData {
  if (datasets.length === 0) {
    throw new Error("No datasets to merge");
  }

  // --- Merge daily contributions ---
  const dayMap = new Map<string, DailyContribution>();

  for (const dataset of datasets) {
    for (const day of dataset.contributions) {
      const existing = dayMap.get(day.date);
      if (!existing) {
        // Deep clone so we don't mutate the source
        dayMap.set(day.date, {
          date: day.date,
          totals: { ...day.totals },
          intensity: day.intensity,
          tokenBreakdown: { ...day.tokenBreakdown },
          clients: day.clients.map((c) => ({
            ...c,
            tokens: { ...c.tokens },
          })),
        });
        continue;
      }

      // Merge clients within this day
      const clientMap = new Map<string, SourceContribution>();
      const keyOf = (c: SourceContribution) =>
        `${c.client}|${c.modelId}|${c.providerId ?? ""}`;

      for (const c of existing.clients) {
        clientMap.set(keyOf(c), { ...c, tokens: { ...c.tokens } });
      }

      for (const c of day.clients) {
        const k = keyOf(c);
        const prev = clientMap.get(k);
        if (!prev) {
          clientMap.set(k, { ...c, tokens: { ...c.tokens } });
        } else {
          prev.tokens = addBreakdown(prev.tokens, c.tokens);
          prev.cost += c.cost;
          prev.messages += c.messages;
        }
      }

      const mergedClients = [...clientMap.values()];

      // Recalculate day totals from merged clients
      const mergedBreakdown = mergedClients.reduce(
        (acc, c) => addBreakdown(acc, c.tokens),
        zeroBreakdown()
      );
      const mergedTotals = {
        tokens: mergedClients.reduce((s, c) => s + c.messages, 0), // messages sum
        cost: mergedClients.reduce((s, c) => s + c.cost, 0),
        messages: mergedClients.reduce((s, c) => s + c.messages, 0),
      };
      // tokens field in totals = actual token count, not messages
      mergedTotals.tokens = totalTokens(mergedBreakdown);

      // Intensity: max across devices (0–4 scale)
      const mergedIntensity = Math.min(
        4,
        Math.max(existing.intensity, day.intensity)
      );

      dayMap.set(day.date, {
        date: day.date,
        totals: mergedTotals,
        intensity: mergedIntensity,
        tokenBreakdown: mergedBreakdown,
        clients: mergedClients,
      });
    }
  }

  const sortedDays = [...dayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // --- Rebuild summary ---
  const allClients = new Set<string>();
  const allModels = new Set<string>();
  let totalTokensSum = 0;
  let totalCostSum = 0;
  let activeDays = 0;
  let maxCost = 0;

  for (const day of sortedDays) {
    if (day.totals.tokens > 0) activeDays++;
    totalTokensSum += day.totals.tokens;
    totalCostSum += day.totals.cost;
    if (day.totals.cost > maxCost) maxCost = day.totals.cost;
    for (const c of day.clients) {
      allClients.add(c.client);
      allModels.add(c.modelId);
    }
  }

  const totalDays = sortedDays.length;
  const averagePerDay = activeDays > 0 ? totalCostSum / activeDays : 0;

  // --- Rebuild year summaries ---
  const yearMap = new Map<string, YearSummary>();
  for (const day of sortedDays) {
    const year = day.date.slice(0, 4);
    const prev = yearMap.get(year);
    if (!prev) {
      yearMap.set(year, {
        year,
        totalTokens: day.totals.tokens,
        totalCost: day.totals.cost,
        range: { start: day.date, end: day.date },
      });
    } else {
      prev.totalTokens += day.totals.tokens;
      prev.totalCost += day.totals.cost;
      if (day.date < prev.range.start) prev.range.start = day.date;
      if (day.date > prev.range.end) prev.range.end = day.date;
    }
  }

  const dateRangeStart = sortedDays[0]?.date ?? "";
  const dateRangeEnd = sortedDays[sortedDays.length - 1]?.date ?? "";

  // Use the most recent meta.version across all datasets
  const latestVersion = datasets
    .map((d) => d.meta.version)
    .sort()
    .at(-1) ?? "unknown";

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      version: latestVersion,
      dateRange: { start: dateRangeStart, end: dateRangeEnd },
    },
    summary: {
      totalTokens: totalTokensSum,
      totalCost: totalCostSum,
      totalDays,
      activeDays,
      averagePerDay,
      maxCostInSingleDay: maxCost,
      clients: [...allClients].sort(),
      models: [...allModels].sort(),
    },
    years: [...yearMap.values()].sort((a, b) => a.year.localeCompare(b.year)),
    contributions: sortedDays,
  };
}
