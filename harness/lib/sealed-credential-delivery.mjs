import { deepFreeze } from "./run-model.mjs";

// A sandbox with a Guardian holds no Task secrets. A credential the Task
// declared for environment delivery, which authoring does for a Suite whose
// checks are advisory, is delivered through the Guardian instead: swapped into
// the Authorization header on the Task's own API hosts, exactly as a required
// check would have declared. Without API hosts there is nowhere to swap it, so
// the run is refused with a reason the operator sees. Local execution has no
// Guardian and keeps environment delivery.
export function sealCredentialBindings(envelope, { sandboxName }) {
  const hosts = envelope.capture?.mode === "none"
    ? []
    : (envelope.capture?.routes ?? []).map(({ host }) => host);
  const sealed = [];
  const exposed = [];
  for (const binding of envelope.credentialBindings) {
    if (binding.delivery.kind === "captured-http-header" || hosts.length === 0) {
      sealed.push(binding);
      if (binding.delivery.kind !== "captured-http-header") exposed.push(binding.environmentName);
      continue;
    }
    sealed.push({
      ...binding,
      delivery: { kind: "captured-http-header", hosts: [...hosts], headerNames: ["authorization"] },
    });
  }
  if (exposed.length) {
    const message = `${sandboxName} sandboxes receive credentials only through the Guardian; the Suite declares no API hosts to carry ${exposed.join(", ")}`;
    throw Object.assign(new TypeError(message), { operatorReason: message });
  }
  return deepFreeze(sealed);
}
