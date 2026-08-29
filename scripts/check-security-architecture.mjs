import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const failures = [];
const requireMatch = (value, pattern, message) => { if (!pattern.test(value)) failures.push(message); };
const requireAbsent = (value, pattern, message) => { if (pattern.test(value)) failures.push(message); };

const worker = read('worker/src/index.ts');
const livekitToken = read('worker/src/livekitToken.ts');
const realtime = read('src/services/realtime.ts');
const profileAssets = read('src/services/profileAssets.ts');
const app = read('src/App.tsx');
const rust = read('src-tauri/src/lib.rs');
const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
const overlayCapability = JSON.parse(read('src-tauri/capabilities/chat-overlay.json'));
const buildScript = read('src-tauri/build.rs');
const styles = read('src/styles.css');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const workerPackage = JSON.parse(read('worker/package.json'));

requireMatch(worker, /const MAX_WS_MESSAGE_BYTES = 64 \* 1024;/, 'Signaling messages must remain capped at 64KiB.');
requireMatch(worker, /const isOwnerReconnect = Boolean\(owner && owner\.stableClientId === stableClientId\);/, 'Owner reconnect must require the private stable client identity.');
requireAbsent(worker, /owner\.peerId === peerId|attachment\.peerId === owner\.peerId/, 'Public peer IDs must never authenticate the room owner.');
requireMatch(worker, /candidate\.stableClientId === attachment\.stableClientId/, 'Replacing an identity socket must not mark the replacement offline.');
requireMatch(worker, /parsed\.from = source\.peerId;/, 'Worker must overwrite client-supplied signaling sender identity.');
requireMatch(worker, /parsed\.profile = sanitizePublicProfile/, 'Worker must strip heavy and unknown fields from signaling profiles.');
requireMatch(worker, /this\.ctx\.storage\.get<ProfileAsset>\(keys\)/, 'Profile assets must use a batch storage read.');
requireMatch(worker, /authorizedProfileAttachment/, 'Profile REST access must be authorized by an approved socket token.');
requireMatch(worker, /handleMediaTokenRequest[\s\S]+authorizedProfileAttachment\(request\)/, 'SFU tokens must require an approved room socket token.');
requireMatch(worker, /LIVEKIT_API_SECRET/, 'SFU token signing secret must come from the Worker environment.');
requireAbsent(worker, /participant_token:\s*['"`]/, 'SFU participant tokens must never be embedded in Worker source.');
requireMatch(livekitToken, /exp:\s*nowSeconds \+ 5 \* 60/, 'SFU join tokens must remain short-lived.');
requireMatch(livekitToken, /canPublishData:\s*false/, 'The media SFU must not become an untracked durable chat path.');
requireMatch(livekitToken, /parsed\.protocol !== 'wss:' && parsed\.protocol !== 'https:'/, 'SFU endpoints must require TLS.');

requireMatch(realtime, /avatarVersion: profileAvatarVersion\(this\.profile\.avatar_data_url\)/, 'Signaling profile must publish only avatar freshness metadata.');
const publicProfile = realtime.slice(realtime.indexOf('private publicProfile()'), realtime.indexOf('private emitPeers()'));
requireAbsent(publicProfile, /avatar:\s*this\.profile\.avatar_data_url/, 'Avatar payload must not be sent through signaling.');
requireMatch(realtime, /data = \{ \.\.\.data, from: peer\.peerId \} as DataPacket;/, 'RTC data packets must be bound to the authenticated peer connection.');
requireMatch(realtime, /chunk\.byteOffset === pending\.receivedBytes/, 'File chunks must be verified as ordered before native writes.');
requireMatch(profileAssets, /Promise\.all\(batches\.map/, 'Profile assets must be fetched in batches rather than N+1 requests.');
requireMatch(app, /useQuery\(\{/, 'Remote profile state must use React Query useQuery.');
requireMatch(app, /useMutation\(\{/, 'Profile publication must use React Query useMutation.');

requireMatch(rust, /if next_written > info\.expected_size/, 'Native file writes must validate the prospective size before writing.');
requireMatch(rust, /if chunk_index != info\.next_chunk_index/, 'Native file writes must reject out-of-order chunks.');
requireMatch(rust, /if size > MAX_ATTACHMENT_BYTES/, 'Native file receive initialization must enforce the 1GB limit.');
requireMatch(rust, /MAX_ACTIVE_FILE_RECEIVES/, 'Native file receive state must be bounded.');

const permissionStrings = capability.permissions.filter((permission) => typeof permission === 'string');
if (permissionStrings.includes('shell:default')) failures.push('The main WebView must not receive shell plugin capability.');
if (permissionStrings.includes('opener:default')) failures.push('The opener plugin must be restricted to the exact approved URL.');
if (capability.windows.length !== 1 || capability.windows[0] !== 'main') failures.push('Privileged main capability must apply only to the main window.');
if (overlayCapability.permissions.some((permission) => !['core:event:allow-listen', 'core:event:allow-unlisten'].includes(permission))) failures.push('Chat overlay capability must remain read-only and event-only.');
requireMatch(buildScript, /AppManifest::new\(\)\.commands\(COMMANDS\)/, 'Application commands must participate in Tauri ACL enforcement.');
requireAbsent(styles, /\.chat-drop-zone\.dragging[^}]+}\s*content:/s, 'Chat drop-zone CSS contains orphan declarations.');
if (tauriConfig.app?.windows?.[0]?.dragDropEnabled !== false) failures.push('Windows HTML5 file drop must disable Tauri\'s competing native drag/drop handler.');
requireMatch(app, /dataTransfer\.types[\s\S]{0,120}includes\('Files'\)/, 'File drag-over must use the Files data-transfer type available before drop.');
requireMatch(app, /event\.dataTransfer\.dropEffect = 'copy'/, 'File drag/drop must communicate copy semantics to Windows.');

const wranglerVersion = workerPackage.devDependencies?.wrangler || '';
if (wranglerVersion !== '4.110.0') failures.push(`Wrangler security baseline must remain 4.110.0 (found ${wranglerVersion || 'missing'}).`);

if (failures.length) {
  console.error('Security architecture validation failed:');
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('MHTalk signaling, REST payload, file-transfer, and Tauri capability security checks passed');
