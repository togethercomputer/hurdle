import { deepFreeze } from "./run-model.mjs";
import {
  compileExchangeFactProfiles,
  exchangeFactProfileMatchesEvent,
  normalizeExchangeFacts,
} from "./exchange-facts.mjs";

const COMMON_EVENT_FIELDS = new Set([
  "kind",
  "sequence",
  "observedAt",
  "scheme",
  "host",
  "path",
  "statusCode",
  "durationMs",
  "selectedFields",
]);
const HTTP_EVENT_FIELDS = new Set([
  ...COMMON_EVENT_FIELDS,
  "method",
  "disposition",
  "exchangeFacts",
]);
const WEBSOCKET_EVENT_FIELDS = new Set([
  ...COMMON_EVENT_FIELDS,
  "framesSent",
  "bytesSent",
  "framesReceived",
  "bytesReceived",
]);
const PROVENANCE_FIELDS = new Set([
  "producer",
  "authority",
  "lifecyclePhase",
  "capturedAt",
  "trust",
]);

export function createCaptureRequest(target) {
  const egress = target?.egress;
  if (!egress || egress.relevantHosts.length === 0) {
    return deepFreeze({ mode: "none" });
  }
  const exchangeFacts = compileExchangeFactProfiles(egress.exchangeFactProfiles ?? []);
  return deepFreeze({
    mode: "network-egress-metadata-v1",
    protocols: [...(egress.protocols ?? ["http", "https"])],
    routes: egress.relevantHosts.map((host) => ({
      host,
      selectedFields: [...egress.selectedFields],
    })),
    ...((egress.blockedRequests?.length ?? 0) > 0 ? {
      blockedRequests: egress.blockedRequests.map(({ id, method, path }) => ({
        id,
        method,
        path,
      })),
    } : {}),
    ...(exchangeFacts ? { exchangeFacts } : {}),
  });
}

export function captureCompatibilityDiagnostics({
  targetDefinition,
  taskDefinitions,
  conditionDefinitions = {},
  cells,
  environment,
}) {
  const requiredCaptureCells = cells.filter(({ taskId, conditionId }) => {
    const task = taskDefinitions[taskId];
    const egress = task.egress ?? targetDefinition?.egress;
    return egress?.captureMode !== "optional"
      || task.executionRequirements?.includes("environment.trusted-egress-capture")
      || conditionDefinitions[conditionId]?.executionRequirements?.includes(
        "environment.trusted-egress-capture",
      );
  });
  const effectiveEgress = ({ taskId }) => (
    taskDefinitions[taskId].egress ?? targetDefinition?.egress ?? {}
  );
  const selectedFields = [...new Set(requiredCaptureCells.flatMap((cell) => (
    effectiveEgress(cell).selectedFields ?? []
  )))].sort();
  const requiredProtocols = [...new Set(requiredCaptureCells.flatMap((cell) => (
    effectiveEgress(cell).protocols ?? []
  )))].sort();
  const exchangeFactProfileIds = [...new Set(requiredCaptureCells.flatMap((cell) => (
    effectiveEgress(cell).exchangeFactProfiles ?? []
  ).map(({ id }) => id)))].sort();
  const capture = environment.captureCapabilities;
  const supportedProtocols = [...new Set(capture?.protocols ?? [])].sort();
  const supportedProtocolSet = new Set(supportedProtocols);
  const missingProtocols = requiredProtocols.filter((protocol) => (
    !supportedProtocolSet.has(protocol)
  ));
  const diagnostics = [];
  if (missingProtocols.length > 0) {
    diagnostics.push(deepFreeze({
      category: "capability",
      code: "matrix.capture-unsupported",
      message: `Execution Environment '${environment.id}' cannot capture protocols required by the selected Targets.`,
      environmentId: environment.id,
      requiredProtocols,
      supportedProtocols,
      missingProtocols,
      plannedCells: cells.length,
    }));
  }
  if (selectedFields.length > 0 && capture?.selectedFields !== true) {
    diagnostics.push(deepFreeze({
      category: "capability",
      code: "matrix.capture-unsupported",
      message: `Execution Environment '${environment.id}' cannot capture selected response fields required by this Target.`,
      environmentId: environment.id,
      selectedFields,
      plannedCells: cells.length,
    }));
  }
  if (exchangeFactProfileIds.length > 0 && capture?.exchangeFacts !== true) {
    diagnostics.push(deepFreeze({
      category: "capability",
      code: "matrix.capture-unsupported",
      message: `Execution Environment '${environment.id}' cannot capture exchange facts required by the selected Targets.`,
      environmentId: environment.id,
      exchangeFactProfileIds,
      plannedCells: cells.length,
    }));
  }
  return diagnostics;
}

function validProvenance(provenance) {
  return provenance
    && typeof provenance === "object"
    && !Array.isArray(provenance)
    && Object.keys(provenance).length === PROVENANCE_FIELDS.size
    && Object.keys(provenance).every((field) => PROVENANCE_FIELDS.has(field))
    && typeof provenance.producer === "string"
    && provenance.producer.trim()
    && Buffer.byteLength(provenance.producer) <= 256
    && ["controller", "environment"].includes(provenance.authority)
    && ["execution", "lifecycle-hook"].includes(provenance.lifecyclePhase)
    && typeof provenance.capturedAt === "string"
    && Number.isFinite(Date.parse(provenance.capturedAt))
    && ["controller-observed", "environment-observed"].includes(provenance.trust);
}

function validSelectedFields(selectedFields) {
  return selectedFields
    && typeof selectedFields === "object"
    && !Array.isArray(selectedFields)
    && Object.keys(selectedFields).length <= 32
    && Object.keys(selectedFields).every((key) => Buffer.byteLength(key) <= 128)
    && Object.values(selectedFields).every((field) => (
      field === null
      || typeof field === "boolean"
      || (typeof field === "number" && Number.isFinite(field))
      || (typeof field === "string" && Buffer.byteLength(field) <= 4096)
    ));
}

function validCommonEvent(event) {
  return event
    && typeof event === "object"
    && Number.isSafeInteger(event.sequence)
    && event.sequence >= 0
    && typeof event.observedAt === "string"
    && Number.isFinite(Date.parse(event.observedAt))
    && typeof event.host === "string"
    && event.host.trim()
    && Buffer.byteLength(event.host) <= 253
    && typeof event.path === "string"
    && event.path.startsWith("/")
    && Buffer.byteLength(event.path) <= 4096
    && !event.path.includes("?")
    && !event.path.includes("#")
    && (event.statusCode === null || Number.isInteger(event.statusCode))
    && (
      event.durationMs === null
      || (Number.isFinite(event.durationMs) && event.durationMs >= 0)
    )
    && validSelectedFields(event.selectedFields ?? {});
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validBlockedRequest(rule) {
  return rule
    && typeof rule === "object"
    && !Array.isArray(rule)
    && Object.keys(rule).length === 3
    && Object.keys(rule).every((key) => ["id", "method", "path"].includes(key))
    && typeof rule.id === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)
    && typeof rule.method === "string"
    && /^[A-Z]{1,16}$/.test(rule.method)
    && typeof rule.path === "string"
    && rule.path.startsWith("/")
    && !rule.path.includes("?")
    && !rule.path.includes("#")
    && Buffer.byteLength(rule.path) <= 4_096;
}

function blockedRequestPolicy(rules) {
  if (
    !Array.isArray(rules)
    || rules.length > 128
    || rules.some((rule) => !validBlockedRequest(rule))
    || new Set(rules.map(({ id }) => id)).size !== rules.length
    || new Set(rules.map(({ method, path }) => `${method}\n${path}`)).size !== rules.length
  ) {
    throw new TypeError("Invalid blocked request policy");
  }
  return rules;
}

function normalizeEvent(
  event,
  index,
  allowedFields,
  exchangeFactPolicy,
  blockedRequests,
  redactText,
  relevantHosts,
) {
  const kind = event?.kind;
  const selectedFields = event?.selectedFields ?? {};
  const allowedEventFields = kind === "http-request"
    ? HTTP_EVENT_FIELDS
    : WEBSOCKET_EVENT_FIELDS;
  const hasUnexpectedFields = Object.keys(event ?? {}).some((field) => (
    !allowedEventFields.has(field)
  ));
  const httpValid = kind === "http-request"
    && !hasUnexpectedFields
    && typeof event.method === "string"
    && /^[A-Z]{1,16}$/.test(event.method)
    && [undefined, "blocked"].includes(event.disposition)
    && (event.scheme === null || ["http", "https"].includes(event.scheme));
  const websocketValid = kind === "websocket-session"
    && !hasUnexpectedFields
    && ["ws", "wss"].includes(event.scheme)
    && event.statusCode === 101
    && event.method === undefined
    && validCounter(event.framesSent)
    && validCounter(event.bytesSent)
    && validCounter(event.framesReceived)
    && validCounter(event.bytesReceived);
  if (!validCommonEvent(event) || (!httpValid && !websocketValid)) {
    throw new TypeError(`Execution Environment returned invalid egress request ${index}`);
  }
  if (
    event.disposition === "blocked"
    && (
      event.statusCode !== 403
      || event.durationMs !== 0
      || Object.keys(selectedFields).length !== 0
      || event.exchangeFacts !== undefined
      || !blockedRequests.some(({ method, path }) => (
        method === event.method && path === event.path
      ))
    )
  ) {
    throw new TypeError(`Execution Environment returned invalid blocked request ${index}`);
  }
  // Guardians compute exchange facts only for relevant hosts; an all-host
  // Guardian may also observe a matching method and path elsewhere.
  const requiresExchangeFacts = kind === "http-request"
    && (relevantHosts === null || relevantHosts.has(String(event.host).toLowerCase()))
    && exchangeFactPolicy?.profiles.some((profile) => (
      exchangeFactProfileMatchesEvent(profile, event)
    ));
  if (requiresExchangeFacts && event.exchangeFacts === undefined) {
    throw new TypeError("Execution Environment returned invalid exchange facts");
  }
  const redactedFields = Object.fromEntries(
    Object.entries(selectedFields)
      .filter(([name]) => allowedFields.has(name))
      .map(([name, field]) => [
        redactText(name),
        typeof field === "string" ? redactText(field) : field,
      ]),
  );
  const common = {
    kind,
    sequence: event.sequence,
    observedAt: redactText(event.observedAt),
    scheme: event.scheme === null ? null : redactText(event.scheme),
    host: redactText(event.host.toLowerCase()),
    path: redactText(event.path),
    statusCode: event.statusCode,
    durationMs: event.durationMs,
    selectedFields: redactedFields,
  };
  if (kind === "http-request") {
    return {
      ...common,
      method: redactText(event.method),
      ...(event.disposition === "blocked" ? { disposition: "blocked" } : {}),
      ...(event.exchangeFacts === undefined
        ? {}
        : { exchangeFacts: normalizeExchangeFacts(event.exchangeFacts, exchangeFactPolicy, event) }),
    };
  }
  return {
    ...common,
    framesSent: event.framesSent,
    bytesSent: event.bytesSent,
    framesReceived: event.framesReceived,
    bytesReceived: event.bytesReceived,
  };
}

export function normalizeEgressCollections({
  collections,
  selectedFieldNames,
  exchangeFactProfiles = [],
  blockedRequests = [],
  relevantHosts = null,
  redactText,
}) {
  if (!Array.isArray(collections) || collections.length < 1 || collections.length > 16) {
    throw new TypeError("Execution Environment returned invalid egress collections");
  }
  if (typeof redactText !== "function") {
    throw new TypeError("Egress normalization requires a redaction function");
  }
  const allowedFields = new Set(selectedFieldNames);
  const exchangeFactPolicy = compileExchangeFactProfiles(exchangeFactProfiles);
  const blockedRequestRules = blockedRequestPolicy(blockedRequests);
  const relevantHostSet = relevantHosts === null
    ? null
    : new Set(relevantHosts.map((host) => String(host).toLowerCase()));
  return collections.map((collection) => {
    if (!validProvenance(collection?.provenance)) {
      throw new TypeError("Execution Environment returned invalid egress provenance");
    }
    const provenance = {
      producer: redactText(collection.provenance.producer),
      authority: collection.provenance.authority,
      lifecyclePhase: collection.provenance.lifecyclePhase,
      capturedAt: collection.provenance.capturedAt,
      trust: collection.provenance.trust,
    };
    if (collection.status === "unavailable") {
      if (
        !["not-configured", "unsupported-platform", "capture-failed"].includes(
          collection.reason,
        )
        || !Array.isArray(collection.requests)
        || collection.requests.length !== 0
      ) {
        throw new TypeError("Execution Environment returned invalid unavailable egress");
      }
      return deepFreeze({
        status: "unavailable",
        reason: collection.reason,
        requests: [],
        provenance,
      });
    }
    if (
      collection.status !== "captured"
      || !Array.isArray(collection.requests)
      || collection.requests.length > 10_000
      || collection.requests.some(({ sequence }, index) => sequence !== index)
    ) {
      throw new TypeError("Execution Environment returned invalid captured egress");
    }
    const observedExchangeFacts = collection.requests.filter((event) => (
      event.exchangeFacts !== undefined
    ));
    if (
      observedExchangeFacts.length > 256
      || Buffer.byteLength(JSON.stringify(observedExchangeFacts.map((event) => (
        event.exchangeFacts
      )))) > 1024 * 1024
      || (
        observedExchangeFacts.length > 0
        && (
          provenance.authority !== "environment"
          || provenance.lifecyclePhase !== "execution"
          || provenance.trust !== "environment-observed"
        )
      )
    ) {
      throw new TypeError("Execution Environment returned invalid exchange facts");
    }
    return deepFreeze({
      status: "captured",
      requests: collection.requests.map((event, index) => (
        normalizeEvent(
          event,
          index,
          allowedFields,
          exchangeFactPolicy,
          blockedRequestRules,
          redactText,
          relevantHostSet,
        )
      )),
      provenance,
    });
  });
}
