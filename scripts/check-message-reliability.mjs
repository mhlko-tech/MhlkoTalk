import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, db, realtime] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/db.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/realtime.ts', import.meta.url), 'utf8')
]);

assert.match(db, /CREATE TABLE IF NOT EXISTS message_outbox/);
assert.match(db, /acknowledgeMessageOutbox/);
assert.match(db, /DELETE FROM message_outbox WHERE room_id/);
assert.match(app, /enqueueMessageOutbox\(pendingSent\)/);
assert.match(app, /pendingOutboxRecipients/);
assert.match(app, /acknowledgeMessageOutbox\(messageId, peerId\)/);
assert.match(app, /!message\.privateTo && !message\.privateFrom/);
assert.match(realtime, /receivedChatIds\.remember/);
assert.match(realtime, /targetPeerIds:/);
assert.match(realtime, /private: Boolean\(message\.privateTo\)/);
assert.match(realtime, /complete_file_receive/);
assert.match(realtime, /fileStatus: 'awaiting-delivery'/);
assert.match(realtime, /if \(data\.type === 'file-stream-progress'\)[\s\S]*?return;/);
assert.match(realtime, /fileReceiveChain/);
assert.match(realtime, /sendFileControl/);
assert.match(realtime, /cancelFileTransfer/);
assert.doesNotMatch(realtime, /file\.size <= INLINE_PREVIEW_MAX_BYTES/);
assert.match(app, /outgoingAttachmentSourcesRef/);
assert.match(app, /retryAttachment/);
assert.match(app, /Stop transfer/);
assert.match(app, /cancelAttachmentTransfer/);
assert.match(app, /message\.fileStatus !== 'awaiting-delivery'/);

console.log('Message reliability architecture checks passed.');
