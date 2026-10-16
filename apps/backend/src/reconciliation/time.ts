import { Temporal } from "@js-temporal/polyfill";
import { timestampSchema, timezoneSchema, type CommitmentValue } from "../contracts";
import type { CompletedUserPart, ProposedCommitment } from "./types";

type Due = Pick<CommitmentValue, "dueAt" | "dueTimezone" | "dueText" | "duePrecision">;
const weekday: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const month: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, oktober: 10, november: 11, december: 12,
};
const unresolved = (text: string): Due => ({ dueAt: null, dueTimezone: null, dueText: text, duePrecision: "unresolved" });

function dateInEvidence(text: string, zone: string, anchor: string | null): string | null {
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) { try { return Temporal.PlainDate.from(iso[0]).toString(); } catch { return null; } }
  if (!anchor) return null;
  const date = Temporal.Instant.from(anchor).toZonedDateTimeISO(zone).toPlainDate();
  if (/\btomorrow\b/i.test(text)) return date.add({ days: 1 }).toString();
  if (/\btoday\b/i.test(text)) return date.toString();
  const calendar = text.match(/\b(\d{1,2})(?:(?:st|nd|rd|th)|\.)?\s+(january|february|march|april|may|june|july|august|september|october|oktober|november|december)(?:[,.]?\s+(\d{4}))?\b/i);
  if (calendar) {
    try {
      const explicitYear = calendar[3] === undefined ? null : Number(calendar[3]);
      let result = Temporal.PlainDate.from({ year: explicitYear ?? date.year, month: month[calendar[2]?.toLowerCase() ?? ""] ?? 0, day: Number(calendar[1]) });
      if (explicitYear === null && Temporal.PlainDate.compare(result, date) < 0) result = result.add({ years: 1 });
      return result.toString();
    } catch { return null; }
  }
  const day = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1]?.toLowerCase();
  if (!day) return null;
  const days = ((weekday[day] ?? 0) - date.dayOfWeek + 7) % 7;
  const next = date.add({ days });
  return /\bbefore\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text) ? next.subtract({ days: 1 }).toString() : next.toString();
}

function timeInEvidence(text: string): string | null {
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})\b/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const spoken = text.match(/\b(?:at|by|before)\s+(\d{1,2})(?:(?::|\.)(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)(?![a-z])/i);
  if (!spoken) return null;
  const rawHour = Number(spoken[1]);
  const minute = Number(spoken[2] ?? "0");
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  const hour = rawHour % 12 + (spoken[3]?.toLowerCase().startsWith("p") ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function zoneFor(proposal: ProposedCommitment, sessionTimezone: string): string | null {
  const zone = proposal.timezone ?? sessionTimezone;
  if (!timezoneSchema.safeParse(zone).success) return null;
  if (proposal.timezone && proposal.timezone !== sessionTimezone && !proposal.due_text?.includes(proposal.timezone)) return null;
  return zone;
}

export function resolveDue(proposal: ProposedCommitment, sessionTimezone: string, evidencePart: CompletedUserPart, supportingEvidence = evidencePart.text): Due {
  const text = proposal.due_text;
  if (proposal.temporal_kind === "none" && proposal.due_precision === "none" && text === null) return { dueAt: null, dueTimezone: null, dueText: null, duePrecision: "none" };
  if (text === null) return { dueAt: null, dueTimezone: null, dueText: null, duePrecision: "none" };
  if (!evidencePart.text.includes(text)) return unresolved(text);
  if (proposal.temporal_kind === "unresolved" || proposal.due_precision === "unresolved") return unresolved(text);
  const zone = zoneFor(proposal, sessionTimezone);
  if (!zone) return unresolved(text);
  try {
    if (proposal.temporal_kind === "relative") {
      const match = text.match(/\bin\s+(\d+)\s+(minutes?|hours?|days?)\b/i);
      const unit = match?.[2]?.toLowerCase() ?? "";
      const factor = unit.startsWith("minute") ? 60 : unit.startsWith("hour") ? 3600 : 0;
      const seconds = Number(match?.[1]) * factor;
      if (!match || !evidencePart.timeAnchorAt || seconds < 1 || seconds !== proposal.relative_seconds) return unresolved(text);
      return { dueAt: timestampSchema.parse(new Date(Temporal.Instant.from(evidencePart.timeAnchorAt).epochMilliseconds + seconds * 1000).toISOString()), dueTimezone: zone, dueText: text, duePrecision: "instant" };
    }
    if (proposal.temporal_kind === "offset") {
      const value = proposal.offset_datetime;
      if (!value || !text.includes(value) || !/([+-]\d{2}:\d{2}|Z)$/i.test(value)) return unresolved(text);
      return { dueAt: timestampSchema.parse(Temporal.Instant.from(value).toString()), dueTimezone: zone, dueText: text, duePrecision: "instant" };
    }
    if (proposal.temporal_kind === "local_date" || proposal.temporal_kind === "local_datetime") {
      const date = dateInEvidence(supportingEvidence, zone, evidencePart.timeAnchorAt);
      if (!date || date !== proposal.local_date) return unresolved(text);
      const time = proposal.temporal_kind === "local_date" ? "09:00" : timeInEvidence(supportingEvidence);
      if (!time || (proposal.temporal_kind === "local_datetime" && time !== proposal.local_time)) return unresolved(text);
      const local = Temporal.PlainDateTime.from(`${date}T${time}`);
      const dueAt = local.toZonedDateTime(zone, { disambiguation: "reject" }).toInstant().toString();
      return { dueAt: timestampSchema.parse(dueAt), dueTimezone: zone, dueText: text, duePrecision: proposal.temporal_kind === "local_date" ? "date" : "instant" };
    }
  } catch { return unresolved(text); }
  return unresolved(text);
}
