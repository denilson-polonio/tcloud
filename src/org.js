'use strict';
const db = require('./db');
const settings = require('./settings');
const storage = require('./storage');

function enable(n) { settings.setOrg('organization', n); }

// Disable the organization: keep the surviving owner, and move every OTHER
// user's content into <survivor>/deleted-users/<username>/… preserving their
// tree (ownership reassigned to the survivor). Then delete those users — their
// FILES are NOT lost. Returns how many users were removed.
function disableAndMigrate(survivorId) {
  const others = db.prepare('SELECT * FROM users WHERE id != ?').all(survivorId);
  const tx = db.transaction(() => {
    if (others.length) {
      const root = storage.createFolder('deleted-users', null, survivorId);
      for (const u of others) {
        const sub = storage.createFolder(u.username, root.id, survivorId);
        const topFolders = db.prepare('SELECT id FROM folders WHERE owner_id=? AND parent_id IS NULL AND system=0').all(u.id).map((r) => r.id);
        const topFiles = db.prepare('SELECT id FROM files WHERE owner_id=? AND folder_id IS NULL').all(u.id).map((r) => r.id);
        const tdrop = db.prepare('SELECT id FROM folders WHERE owner_id=? AND system=1').get(u.id);
        db.prepare('UPDATE folders SET owner_id=? WHERE owner_id=?').run(survivorId, u.id);
        db.prepare('UPDATE files SET owner_id=? WHERE owner_id=?').run(survivorId, u.id);
        if (tdrop) { db.prepare('UPDATE files SET folder_id=? WHERE folder_id=?').run(sub.id, tdrop.id); db.prepare('DELETE FROM folders WHERE id=?').run(tdrop.id); }
        for (const fid of topFolders) db.prepare('UPDATE folders SET parent_id=? WHERE id=?').run(sub.id, fid);
        for (const fid of topFiles) db.prepare('UPDATE files SET folder_id=? WHERE id=?').run(sub.id, fid);
        db.prepare('DELETE FROM users WHERE id=?').run(u.id); // cascades sessions + that user's share rows
      }
    }
    settings.setOrg('personal', '');
  });
  tx();
  return { removed: others.length };
}
module.exports = { enable, disableAndMigrate };
