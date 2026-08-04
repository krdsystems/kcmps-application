/* ============================================================
   KCMPS backend — plain-English malware descriptions
   ============================================================
   Turns a GuardDuty/antivirus threat name into something a non-technical
   staff member can act on. GuardDuty reports the underlying engine's
   signature name — `Trojan:Win32/Emotet`, `Ransom.Win32.WannaCry`,
   `EICAR-Test-File (not a virus)` — which is meaningless to whoever is
   actually standing at the press deciding what to tell the customer.

   Deliberately a static lookup, not an LLM call. AV signature names are a
   small, highly conventional vocabulary (the family prefix carries almost
   all the meaning), so a table is deterministic, free, adds no latency or
   IAM surface, and can be unit-tested. Generating security wording from a
   model at runtime would be non-deterministic on exactly the kind of
   message that must not vary — and would cost per scan for no gain.

   Matching is by family keyword against the whole threat string, most
   specific first, because engines put the family in different positions
   (`Trojan:Win32/X`, `Win32.Trojan.X`, `X.Trojan.gen`). Anything
   unrecognized falls through to a deliberately non-alarming generic —
   staff should treat "we don't know what this is" as "don't open it",
   not as "probably fine".

   `severity` is for UI emphasis only, never for a decision: EVERY entry
   here means the file was deleted and cannot be opened. A "low" severity
   adware hit is still a blocked file.
   ============================================================ */

// Ordered: first match wins, so put specific families above broad ones.
const THREAT_PATTERNS = [
  {
    match: /eicar/i,
    label: "Antivirus test file",
    plain: "This isn't real malware — it's a harmless file used to check that virus scanning is working.",
    advice: "If a customer sent this, they were probably testing. Ask them to send the real artwork.",
    severity: "info",
  },
  {
    match: /ransom|crypt(o)?locker|wannacry/i,
    label: "Ransomware",
    plain: "Software that locks up your files and demands payment to unlock them.",
    advice: "Do not ask the customer to resend the same file. Contact them by phone or chat — their computer may be infected.",
    severity: "critical",
  },
  {
    match: /backdoor|rootkit|rat\b|remoteadmin/i,
    label: "Remote-access malware",
    plain: "Software that lets a stranger secretly control the computer it runs on.",
    advice: "Do not open anything else from this sender until you've spoken to them directly.",
    severity: "critical",
  },
  {
    match: /spyware|infostealer|stealer|pws|keylog|passwordstealer/i,
    label: "Password stealer",
    plain: "Software built to steal saved passwords, card details, and login sessions.",
    advice: "Don't reopen this file anywhere. If anyone did open it, change the passwords on that computer.",
    severity: "critical",
  },
  {
    match: /worm/i,
    label: "Self-spreading virus",
    plain: "A virus that copies itself onto other computers on the same network by itself.",
    advice: "Nothing to do here — it was deleted before it could spread. Warn the customer their device may be infected.",
    severity: "critical",
  },
  {
    match: /exploit|cve-\d{4}|shellcode/i,
    label: "Booby-trapped document",
    plain: "A file built to attack a bug in the program that opens it — the damage happens the moment you open it, with no warning.",
    advice: "Ask the customer to re-export a fresh copy from their design software rather than resending this one.",
    severity: "critical",
  },
  {
    match: /macro|w97m|x97m|o97m|vba/i,
    label: "Office file with a harmful macro",
    plain: "A Word/Excel-style document carrying a hidden mini-program that runs when you open it.",
    advice: "Ask the customer to send a PDF export instead of the Office file.",
    severity: "high",
  },
  {
    match: /phish/i,
    label: "Phishing file",
    plain: "A fake document designed to trick whoever opens it into typing a password or card number.",
    advice: "Don't enter credentials anywhere this file pointed to. Confirm with the customer that they actually sent it.",
    severity: "high",
  },
  {
    match: /downloader|dropper|loader/i,
    label: "Malware installer",
    plain: "A small file whose only job is to quietly download and install something worse.",
    advice: "Ask the customer to re-export a clean copy of their artwork.",
    severity: "critical",
  },
  {
    match: /trojan/i,
    label: "Trojan (disguised malware)",
    plain: "Harmful software dressed up as an ordinary file so you'll open it.",
    advice: "Ask the customer to re-export a clean copy. If it happens twice, their computer is likely infected.",
    severity: "critical",
  },
  {
    match: /adware|\bpua\b|\bpup\b|unwanted|riskware|bundler/i,
    label: "Unwanted software",
    plain: "Not usually dangerous, but it's bundled with ads or tracking that shouldn't be in a print file.",
    advice: "Ask the customer to re-export the artwork on its own.",
    severity: "low",
  },
  {
    match: /heur|generic|suspicious|obfus|packed|malformed/i,
    label: "Suspicious file",
    plain: "Nothing specific was identified, but the file behaves like malware — often because it's been deliberately scrambled to hide what it does.",
    advice: "Could occasionally be a false alarm on an unusual design file. Ask the customer to re-export it, or to share it via a Drive link instead.",
    severity: "medium",
  },
  {
    match: /virus|malware|infected/i,
    label: "Virus",
    plain: "Harmful software that can damage files or spread to other computers.",
    advice: "Ask the customer to re-export a clean copy of their artwork.",
    severity: "critical",
  },
];

const UNKNOWN_THREAT = Object.freeze({
  label: "Unrecognized threat",
  plain: "Our scanner flagged this file as harmful but didn't recognize exactly what it is.",
  advice: "Treat it as unsafe. Ask the customer to re-export the file or send it as a Drive link instead.",
  severity: "high",
});

// Takes GuardDuty's `threats` array (strings) and returns one plain-English
// summary for the whole attachment. Multiple hits on one file are normal —
// engines report every signature that matched — so this describes the most
// serious one rather than listing all of them at staff.
function describeThreats(threats) {
  const names = (threats || []).filter(Boolean).map(String);
  if (!names.length) return null;

  const joined = names.join(" ");
  // First pattern in table order that matches ANY of the reported names.
  // Table order is severity-meaningful, so this naturally surfaces the
  // worst applicable description — except for the EICAR test entry, which
  // is first precisely because "this is only a test file" outranks
  // everything else when it applies.
  const hit = THREAT_PATTERNS.find((p) => p.match.test(joined));
  const base = hit || UNKNOWN_THREAT;
  return {
    label: base.label,
    plain: base.plain,
    advice: base.advice,
    severity: base.severity,
    // Kept so the raw signature is always recoverable for a real
    // investigation, without putting it in front of non-technical staff.
    technical: names.join(", "),
  };
}

module.exports = { describeThreats, THREAT_PATTERNS, UNKNOWN_THREAT };
