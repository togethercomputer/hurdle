const nonblank = value => typeof value === "string" && value.trim().length > 0;

export async function ensureSetupCredentials({ requirements, environment, interactive, prompt, io, report }) {
  report.requiredCredentials = requirements;
  const missing = requirements.filter(({ anyOf }) => !anyOf.some(name => nonblank(environment[name])));
  report.missingCredentials = missing;
  if (missing.length && !interactive) {
    // A sandbox and a Task can need the same key; name it once.
    const names = [...new Set(missing.map(({ anyOf }) => anyOf.join(" or ")))].join("; ");
    throw Object.assign(new Error(`Missing credentials: ${names}. Set them in .env.local or the environment, then rerun setup. .env.local overrides the environment; use --interactive to enter missing values in a terminal.`), { code: "setup.credentials-missing" });
  }
  const entered = {};
  for (const { anyOf, label } of missing) {
    if (anyOf.some(name => nonblank(environment[name]))) continue;
    let name = anyOf[0];
    if (anyOf.length > 1) {
      const choice = await prompt({ message: `  ${label} credential (${anyOf.join(" / ")}) [${name}]: ` }, io);
      if (choice === null) throw Object.assign(new Error("Setup cancelled; no resources were created."), { code: "setup.cancelled" });
      if (choice.trim()) name = choice.trim();
      if (!anyOf.includes(name)) throw Object.assign(new Error(`Choose ${anyOf.join(" or ")} and rerun setup.`), { code: "setup.credential" });
    }
    const value = await prompt({ message: `  ${name} (hidden): `, secret: true }, io);
    if (value === null) throw Object.assign(new Error("Setup cancelled; no resources were created."), { code: "setup.cancelled" });
    if (!/^[\x21-\x7e]+$/.test(value)) throw Object.assign(new Error("Enter a nonblank credential without spaces or line breaks."), { code: "setup.credential" });
    environment[name] = entered[name] = value;
  }
  report.missingCredentials = [];
  return entered;
}
