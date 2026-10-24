// settings-console.js — the single-message Telegram settings console.
//
//   ⚙️ Settings console (k0)
//     ├─ Basics            tiny set of knobs, one tap each (dry run, profile, positions, size, source, strategy, LLM)
//     ├─ Profile picker    (kp)  conservative | balanced | degen | custom, with a diff + confirm (kq:<name>)
//     ├─ Tuning            (kt, kt:<section>) the ~25 profile-governed knobs, grouped; ✎ marks a manual override
//     └─ Advanced          (as)  the full All-settings editor, collapsed behind one button
//
// The whole thing is one message edited in place (telegram-ui.js show()). Rendering is pure;
// everything with side effects is injected. Secrets (private key, RPC URL, bot token, API keys)
// are .env-only and never listed; typed values that look like a private key are refused
// (looksLikeSecret) so a key pasted into the chat never reaches a setting or the LLM.
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { PROFILES, UNTESTED_PROFILES, PROFILE_NAMES, diffProfile, tierCounts, BY_KEY } from "./settings-schema.js";

/** Basics shown first, in order. Keys not present in the registry (e.g. a removed key) are skipped. */
export const BASIC_KEYS = ["dryRun", "maxPositions", "positionSizePct", "maxDeployAmount", "screeningSource", "activeStrategy", "strategy", "llmProvider"];

/** Tuning sections: the profile-governed keys, grouped by what they control. */
export const TUNING_SECTIONS = [
  { id: "exit", label: "Exits", pick: (r) => r.path?.[0] === "management" && /Pct$|Minutes$/.test(r.key) && r.key !== "positionSizePct" },
  { id: "scr", label: "Screening", pick: (r) => r.path?.[0] === "screening" },
  { id: "ent", label: "Entry filters", pick: (r) => r.path?.[0] === "entryFilters" },
  { id: "siz", label: "Sizing", pick: (r) => ["deployAmountSol", "gasReserve"].includes(r.key) },
  { id: "cad", label: "Cadence", pick: (r) => r.path?.[0] === "schedule" },
  // Not profile-governed (no preset changes it), but it is a tuning knob: the Bid-Ask share of the "hybrid" shape.
  { id: "shp", label: "Hybrid shape", ungoverned: true, pick: (r) => r.key === "hybridBidAskPct" },
];

const fmt = (v) => (v === null || v === undefined ? "off" : typeof v === "boolean" ? (v ? "on" : "off") : Array.isArray(v) ? v.join(", ") : String(v));

/**
 * True for text that looks like a wallet private key. In free chat (`awaiting: false`) only HIGH-confidence shapes are
 * refused: base58 (87-88 chars) that decodes to a valid ed25519 keypair, a 64-number JSON byte array, and 128-char hex.
 * While the console awaits a typed value (`awaiting: true`) the broader heuristics also apply (other 80-92 char base58,
 * 64-hex, 32+ number arrays). A tx signature (64 bytes, also 87-88 base58) fails the keypair check and always passes.
 */
export function looksLikeSecret(text, { awaiting = false } = {}) {
  const t = String(text ?? "").trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{80,92}$/.test(t)) {
    if (t.length < 87 || t.length > 88) return awaiting;
    try {
      const bytes = bs58.decode(t);
      if (bytes.length !== 64) return awaiting;
      Keypair.fromSecretKey(bytes); // throws unless pubkey matches the seed
      return true;
    } catch { return false; } // 64 bytes that are not a keypair: a tx signature
  }
  if (/^[0-9a-fA-F]{128}$/.test(t)) return true;
  if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/.test(t)) return true; // 64-byte keypair file contents
  if (!awaiting) return false;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return true;
  if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]$/.test(t)) return true;
  return false;
}

export function createConsole({ btn, escapeHtml, clipText }) {
  const tag = (name) => (UNTESTED_PROFILES.has(name) ? " ⚠️ untested starting point" : name === "balanced" ? " (the values this bot has been running)" : "");

  function entryOf(svc, key) {
    return svc.find(key);
  }

  function valueLine(svc, e, sourceOf) {
    const cur = svc.current(e);
    const suffix = cur === null || cur === undefined || typeof cur === "boolean" || !e.unit ? "" : e.unit === "%" ? "%" : ` ${e.unit}`;
    return { text: `${fmt(cur)}${suffix}`, over: sourceOf?.(e.key) === "user" };
  }

  /** Main console. */
  function renderConsole(svc, { dryRun = false, profile = "custom", note = null } = {}) {
    const counts = tierCounts();
    const lines = [
      "⚙️ <b>Settings console</b>",
      `Mode: <b>${dryRun ? "DRY RUN" : "LIVE"}</b> · Profile: <b>${escapeHtml(profile)}</b>${escapeHtml(tag(profile))}`,
      "",
      "<b>Basics</b>",
    ];
    const basics = BASIC_KEYS.map((k) => entryOf(svc, k)).filter(Boolean);
    for (const e of basics) {
      const label = e.label ?? e.key;
      lines.push(`• ${escapeHtml(label)}: <b>${escapeHtml(clipText(fmt(svc.current(e)), 40))}</b>${e.restart ? " ⟳" : ""}`);
    }
    lines.push(
      "",
      `<b>Tuning</b>: ${counts.governed} knobs (exits, screening, entry filters, sizing, cadence) set by the profile. Changing one yourself marks it ✎.`,
      `<b>Advanced</b>: everything else (collapsed). Defaults are fine.`,
      "",
      "🔐 Wallet key, RPC URL, bot token and API keys are <b>.env only</b>: they are never shown here and never accepted in chat.",
    );
    if (basics.some((e) => e.restart)) lines.push("⟳ = applies after a restart.");
    if (note) lines.push("", note);

    const keyboard = [];
    const dry = entryOf(svc, "dryRun");
    if (dry) keyboard.push([btn(dryRun ? "🧪 DRY RUN: tap to go LIVE" : "🔴 LIVE: tap to go DRY RUN", `ak:${dry.id}`)]);
    keyboard.push([btn(`🎚 Profile: ${profile} ▸`, "kp")]);
    const rest = basics.filter((e) => e.key !== "dryRun");
    const bb = rest.map((e) => btn(clipText(`${e.label ?? e.key}: ${fmt(svc.current(e))}`, 32), `ak:${e.id}`));
    for (let i = 0; i < bb.length; i += 2) keyboard.push(bb.slice(i, i + 2));
    keyboard.push([btn(`🛠 Tuning (${counts.governed}) ▸`, "kt"), btn("🧾 Advanced ▸", "as")]);
    keyboard.push([btn("📋 Full report", "se:0"), btn("⬅ Menu", "m")]);
    return { text: lines.join("\n"), keyboard };
  }

  function renderProfilePicker(current) {
    const lines = [
      "🎚 <b>Profile</b>",
      "A profile sets all the Tuning knobs at once (exits, screening, entry filters, sizing, cadence). You are on <b>" + escapeHtml(current) + "</b>.",
      "",
      "• <b>conservative</b>: tighter exits, stricter screening, fewer and smaller positions. ⚠️ untested starting point",
      "• <b>balanced</b>: the values this bot has been running live.",
      "• <b>degen</b>: wider exits, looser screening, more positions. ⚠️ untested starting point",
      "• <b>custom</b>: you set every knob; nothing is overwritten. (A config from before profiles loads as custom.)",
      "",
      "You get a diff and a confirm before anything changes.",
    ];
    const keyboard = PROFILE_NAMES.map((n) => [btn(`${n === current ? "✅ " : ""}${n}${UNTESTED_PROFILES.has(n) ? " ⚠️" : ""}`, `kq:${n}`)]);
    keyboard.push([btn("⚙️ Console", "k0"), btn("⬅ Menu", "m")]);
    return { text: lines.join("\n"), keyboard };
  }

  /** Diff card text for switching to `name`. */
  function renderProfileDiff(name, diff, current) {
    const lines = [`🎚 <b>Switch profile: ${escapeHtml(current)} → ${escapeHtml(name)}?</b>`];
    if (UNTESTED_PROFILES.has(name)) lines.push("⚠️ These numbers are an <b>untested starting point</b>, not tuned on live results.");
    if (name === "custom") {
      lines.push("Pins every Tuning knob to the value it has right now. Nothing changes behavior; you just own the numbers.");
    } else {
      lines.push("Your manual overrides of Tuning knobs are dropped so the profile takes effect.");
      if (!diff.length) lines.push("", "No values change.");
      else {
        lines.push("", `<b>${diff.length} value${diff.length === 1 ? "" : "s"} change:</b>`);
        for (const d of diff.slice(0, 30)) lines.push(`• <code>${escapeHtml(d.key)}</code>: ${escapeHtml(fmt(d.from))} → <b>${escapeHtml(fmt(d.to))}</b>`);
        if (diff.length > 30) lines.push(`…and ${diff.length - 30} more`);
      }
    }
    return lines.join("\n");
  }

  function renderTuningIndex(svc, { profile, sourceOf }) {
    const lines = ["🛠 <b>Tuning</b>", `Profile: <b>${escapeHtml(profile)}</b>. ✎ = you overrode the profile's value.`, ""];
    const keyboard = [];
    for (const sec of TUNING_SECTIONS) {
      const es = sectionEntries(svc, sec);
      const over = sourceOf ? es.filter((e) => sourceOf(e.key) === "user").length : 0;
      lines.push(`• ${sec.label}: ${es.length} knobs${profile !== "custom" && over ? `, ${over} ✎` : ""}`);
      keyboard.push([btn(`${sec.label} (${es.length}) ▸`, `kt:${sec.id}`)]);
    }
    keyboard.push([btn("⚙️ Console", "k0"), btn("⬅ Menu", "m")]);
    return { text: lines.join("\n"), keyboard };
  }

  function sectionEntries(svc, sec) {
    return svc.entries.filter((e) => (e.governed || sec.ungoverned) && !BASIC_KEYS.includes(e.key) && sec.pick(BY_KEY.get(e.key) ?? { key: e.key, path: e.path }));
  }

  function renderTuningSection(svc, secId, { profile, sourceOf }) {
    const sec = TUNING_SECTIONS.find((s) => s.id === secId);
    if (!sec) return { text: "Unknown section.", keyboard: [[btn("🛠 Tuning", "kt"), btn("⬅ Menu", "m")]] };
    const es = sectionEntries(svc, sec);
    const lines = [`🛠 <b>${escapeHtml(sec.label)}</b> · profile <b>${escapeHtml(profile)}</b>`, ""];
    for (const e of es) {
      const { text, over } = valueLine(svc, e, sourceOf);
      lines.push(`<code>${escapeHtml(e.key)}</code> = <b>${escapeHtml(text)}</b>${over && profile !== "custom" ? " ✎" : ""}${e.restart ? " ⟳" : ""}`);
    }
    if (es.some((e) => e.restart)) lines.push("", "⟳ = applies after a restart");
    const keyboard = [];
    const kb = es.map((e) => btn(clipText(e.key, 30), `ak:${e.id}`));
    for (let i = 0; i < kb.length; i += 2) keyboard.push(kb.slice(i, i + 2));
    keyboard.push([btn("🛠 Tuning", "kt"), btn("⚙️ Console", "k0")]);
    return { text: lines.join("\n"), keyboard };
  }

  return { renderConsole, renderProfilePicker, renderProfileDiff, renderTuningIndex, renderTuningSection, sectionEntries };
}

/**
 * Profile service for the console. deps: { config, switchProfile, currentGovernedValues,
 * onScheduleChange?(key, value), log? }.
 */
export function createProfileService({ config, switchProfile, currentGovernedValues, onScheduleChange, log = () => {} }) {
  return {
    current: () => config.profile ?? "custom",
    names: PROFILE_NAMES,
    /** Values that would change if `name` were applied now. */
    preview: (name) => (name === "custom" || !PROFILES[name] ? [] : diffProfile(name, currentGovernedValues())),
    apply(name) {
      const r = switchProfile(name);
      for (const key of r.scheduleChanged) {
        try { onScheduleChange?.(key, config.schedule[key]); } catch (e) { log("config_error", `Reschedule after profile switch failed (${key}): ${e.message}`); }
      }
      log("config", `Profile switched to ${r.profile} from Telegram (${r.changed.length} values changed)`);
      return r;
    },
  };
}
