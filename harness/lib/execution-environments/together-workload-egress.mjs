import { RELAY_PORT } from "./guardian.mjs";

// Steps that seal a Together workload's egress once its loopback relay port
// reaches the controller-host Guardian. Run by the server inside a Together
// Hurdle sandbox against its own processes.

// The Guardian answers CONNECTs to this host itself, so the path can be proven
// even when a task has no capture hosts.
export const PREFLIGHT_HOST = "preflight.hurdle.invalid";

// Prove the complete loopback -> controller -> Guardian TCP path before
// starting an Agent. CONNECT opens TLS transport without an API request.
export async function verifyGuardianPath(workload, host, signal) {
  const checked = await workload.commands.run(String.raw`node - <<'JS'
const socket = require('node:net').createConnection({ host: '127.0.0.1', port: ${RELAY_PORT} });
let received = '';
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 10000);
socket.once('connect', () => socket.write('CONNECT ' + process.env.HURDLE_CAPTURE_HOST + ':443 HTTP/1.1\r\nHost: ' + process.env.HURDLE_CAPTURE_HOST + ':443\r\n\r\n'));
socket.on('data', data => {
  received += data.toString();
  if (received.length > 16384) { socket.destroy(); process.exitCode = 1; }
  else if (received.includes('\r\n\r\n')) {
    if (/^HTTP\/1\.[01] 200 /.test(received)) console.log('GUARDIAN_BRIDGE_READY');
    else process.exitCode = 1;
    socket.destroy();
  }
});
socket.once('error', () => { process.exitCode = 1; });
socket.once('close', () => { clearTimeout(timer); if (!/^HTTP\/1\.[01] 200 /.test(received)) process.exitCode = 1; });
JS`, { user: "root", timeoutMs: 15000, signal,
    envs: { HURDLE_CAPTURE_HOST: host ?? PREFLIGHT_HOST } });
  if (!checked.stdout?.includes("GUARDIAN_BRIDGE_READY")) {
    throw new Error("Together Guardian end-to-end preflight failed");
  }
}

// The SDK root-exec endpoint must never be accessible to the Agent.
export async function blockSandboxAgentPort(workload, signal) {
  await workload.commands.run(`set -eu
for binary in /usr/sbin/iptables-legacy /usr/sbin/ip6tables-legacy; do
  "$binary" --wait 5 -I OUTPUT 1 -p tcp --dport 57468 -j DROP
  "$binary" --wait 5 -C OUTPUT -p tcp --dport 57468 -j DROP
done`, { user: "root", timeoutMs: 10000, signal });
}
