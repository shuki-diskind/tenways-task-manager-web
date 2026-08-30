// The shared-records screen: list, add/edit modal, deletes, live updates,
// search + filters, assignment/visibility/categories - and the optimistic-
// locking conflict handling that keeps two people from silently overwriting
// each other.
(function () {
  'use strict';

  var sb = window.sb;
  var $ = function (id) { return document.getElementById(id); };

  // Every read pulls the row plus the profile of whoever created/edited it.
  // The explicit FK names disambiguate the two joins to profiles.
  var TODO_SELECT = [
    'id', 'title', 'description', 'notes', 'status', 'priority', 'due_date',
    'assigned_to', 'visible_to', 'category_ids',
    'version', 'created_at', 'updated_at', 'created_by', 'updated_by',
    'editor:profiles!todos_updated_by_fkey(display_name,email)',
    'creator:profiles!todos_created_by_fkey(display_name,email)',
  ].join(',');

  var STATUS_LABELS = { open: 'Open', in_progress: 'In progress', done: 'Done' };
  var PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High' };

  var state = {
    user: null,
    myProfile: null,
    todos: [],
    profiles: [],
    categories: [],
    perms: [],          // category_permissions rows (own rows; all rows for admins)
    channel: null,
    modal: null,        // { mode, id, version, current, sel: {assigned,visible,cats} }
    reloadTimer: null,
    retryTimer: null,
    clockTimer: null,
  };

  // ---------- small helpers ----------

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function personName(profile) {
    if (profile && profile.display_name) return profile.display_name;
    if (profile && profile.email) return profile.email;
    return 'someone else'; // profile gone (removed account)
  }

  function profileName(id) {
    var p = state.profiles.find(function (x) { return x.id === id; });
    return p ? p.display_name : 'someone';
  }

  function categoryName(id) {
    var c = state.categories.find(function (x) { return x.id === id; });
    return c ? c.name : null; // null = category was deleted; skip it
  }

  function permsFor(userId, catId) {
    var r = state.perms.find(function (p) {
      return p.user_id === userId && p.category_id === catId;
    });
    return r || { user_id: userId, category_id: catId, can_view: false, can_create: false };
  }

  function myPerm(catId) { return permsFor(state.user.id, catId); }

  function isAdmin() {
    return !!(state.myProfile && state.myProfile.role === 'admin');
  }

  function relTime(iso) {
    var secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 45) return 'just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(iso).toLocaleDateString();
  }

  function fullTime(iso) { return new Date(iso).toLocaleString(); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function formatDue(dstr) {
    if (!dstr) return '';
    var p = dstr.split('-').map(Number); // parse as LOCAL date, not UTC
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  var toastTimer = null;
  function toast(msg, kind, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, ms || 3500);
  }

  // ---------- data access ----------

  function fetchTodos() {
    return sb.from('todos').select(TODO_SELECT)
      .order('created_at', { ascending: false })
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function fetchProfiles() {
    return sb.from('profiles').select('id, email, display_name, first_name, last_name, role')
      .order('display_name')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function fetchCategories() {
    return sb.from('categories').select('id, name')
      .order('name')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function fetchPerms() {
    return sb.from('category_permissions')
      .select('user_id, category_id, can_view, can_create')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function fetchOne(id) {
    return sb.from('todos').select(TODO_SELECT).eq('id', id).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data; // null when the row no longer exists (or is now hidden)
      });
  }

  async function reload(showErrors) {
    try {
      var results = await Promise.all([fetchTodos(), fetchProfiles(), fetchCategories(), fetchPerms()]);
      state.todos = results[0];
      state.profiles = results[1];
      state.categories = results[2];
      state.perms = results[3];
      state.myProfile = state.profiles.find(function (p) { return p.id === state.user.id; }) || null;
      updateAdminUi();
      renderCategoryFilter();
      renderAssignedFilter();
      if (catModal.open && !catModal.editingId) renderCatModal();
      if (adminModal.open && !adminModal.pwEditId && !adminModal.nameEditId) renderAdminUsers();
      render();
    } catch (err) {
      console.log('[app] reload failed: ' + err.message);
      if (showErrors) toast('Could not load records: ' + err.message, 'error', 6000);
    }
  }

  // Optimistic-locking update. The .eq('version', ...) filter is the lock:
  // if someone saved after we loaded the row, the filter matches 0 rows and
  // nothing is written. Returns one of:
  //   { ok: row }                      saved; row carries the new version
  //   { conflict: 'changed', current } someone else saved first
  //   { conflict: 'deleted' }          someone else deleted (or hid) the row
  async function saveWithVersionCheck(id, expectedVersion, fields) {
    var res = await sb.from('todos')
      .update(fields)
      .eq('id', id)
      .eq('version', expectedVersion)
      .select(TODO_SELECT);
    if (res.error) throw res.error;
    if (res.data && res.data.length > 0) return { ok: res.data[0] };
    var current = await fetchOne(id);
    if (!current) return { conflict: 'deleted' };
    return { conflict: 'changed', current: current };
  }

  async function deleteWithVersionCheck(id, expectedVersion) {
    var res = await sb.from('todos')
      .delete()
      .eq('id', id)
      .eq('version', expectedVersion)
      .select('id');
    if (res.error) throw res.error;
    if (res.data && res.data.length > 0) return { ok: true };
    var current = await fetchOne(id);
    if (!current) return { ok: true, already: true }; // gone either way
    return { conflict: 'changed', current: current };
  }

  function upsertLocal(row) {
    var i = state.todos.findIndex(function (t) { return t.id === row.id; });
    if (i >= 0) state.todos[i] = row; else state.todos.unshift(row);
    render();
  }

  function removeLocal(id) {
    state.todos = state.todos.filter(function (t) { return t.id !== id; });
    render();
  }

  // ---------- rendering ----------

  function matchesFilters(t) {
    var q = $('search-box').value.trim().toLowerCase();
    var st = $('filter-status').value;
    var cat = $('filter-category').value;
    var asg = $('filter-assigned').value;
    if (st && t.status !== st) return false;
    if (cat && (t.category_ids || []).indexOf(cat) < 0) return false;
    if (asg === '__everyone__') {
      if ((t.assigned_to || []).length > 0) return false;
    } else if (asg && (t.assigned_to || []).indexOf(asg) < 0) {
      return false;
    }
    if (q && t.title.toLowerCase().indexOf(q) < 0 &&
        (t.description || '').toLowerCase().indexOf(q) < 0 &&
        (t.notes || '').toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  function render() {
    var rows = state.todos.filter(matchesFilters);
    var tbody = $('todo-tbody');
    tbody.replaceChildren.apply(tbody, rows.map(renderRow));

    $('empty-state').classList.toggle('hidden', state.todos.length !== 0);
    $('no-match-state').classList.toggle('hidden', !(state.todos.length > 0 && rows.length === 0));

    var total = state.todos.length;
    var done = state.todos.filter(function (t) { return t.status === 'done'; }).length;
    var label = total + (total === 1 ? ' record' : ' records');
    if (total > 0) label += ' · ' + (total - done) + ' active · ' + done + ' done';
    if (rows.length !== total) label += ' · showing ' + rows.length;
    $('count-label').textContent = label;
  }

  function renderRow(t) {
    var tr = el('tr', 'status-' + t.status);

    var tdTitle = el('td', 'col-title');
    var titleLine = el('div', 'title-text', t.title);
    if ((t.visible_to || []).length > 0) {
      var lock = el('span', 'lock', '🔒');
      lock.title = 'Only visible to: ' + t.visible_to.map(profileName).join(', ') +
        '\n(plus assignees, the creator, and admins)';
      titleLine.appendChild(lock);
    }
    tdTitle.appendChild(titleLine);
    var catNames = (t.category_ids || []).map(categoryName).filter(Boolean);
    if (catNames.length) {
      var chips = el('div', 'chips');
      catNames.forEach(function (name) { chips.appendChild(el('span', 'chip', name)); });
      tdTitle.appendChild(chips);
    }
    tr.appendChild(tdTitle);

    var tdNotes = el('td', 'col-notes muted');
    tdNotes.appendChild(el('div', 'notes-text', t.description || ''));
    var hoverText = [t.description, t.notes ? 'Notes: ' + t.notes : '']
      .filter(Boolean).join('\n\n');
    if (hoverText) tdNotes.title = hoverText;
    tr.appendChild(tdNotes);

    // Status is editable straight from the table; it goes through the same
    // version check as the edit form.
    var tdStatus = el('td', 'col-status');
    var sel = el('select', 'status-select pill-' + t.status);
    sel.title = 'Change status';
    Object.keys(STATUS_LABELS).forEach(function (val) {
      var o = el('option', null, STATUS_LABELS[val]);
      o.value = val;
      if (val === t.status) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onInlineStatusChange(t.id, t.version, sel); });
    tdStatus.appendChild(sel);
    tr.appendChild(tdStatus);

    var tdPr = el('td', 'col-priority');
    tdPr.appendChild(el('span', 'prio prio-' + t.priority, PRIORITY_LABELS[t.priority] || t.priority));
    tr.appendChild(tdPr);

    var tdDue = el('td', 'col-due');
    if (t.due_date) {
      var overdue = t.status !== 'done' && t.due_date < todayStr();
      tdDue.appendChild(el('span', overdue ? 'due overdue' : 'due', formatDue(t.due_date)));
      if (overdue) tdDue.title = 'Overdue';
    }
    tr.appendChild(tdDue);

    var tdAsg = el('td', 'col-assigned');
    var asgIds = t.assigned_to || [];
    var asgNames = asgIds.map(function (id) {
      var p = state.profiles.find(function (x) { return x.id === id; });
      return p ? p.display_name : null;  // skip ids whose profile is gone
    }).filter(Boolean);
    tdAsg.appendChild(el('div', 'assigned-names' + (asgIds.length === 0 ? ' muted' : ''),
      asgIds.length === 0 ? 'Everyone' : (asgNames.join(', ') || '—')));
    tr.appendChild(tdAsg);

    var tdEd = el('td', 'col-edited');
    var who = personName(t.editor);
    tdEd.appendChild(el('div', 'edited-who', who));
    tdEd.appendChild(el('div', 'edited-when muted small', relTime(t.updated_at)));
    tdEd.title = 'Last edited by ' + who + ' on ' + fullTime(t.updated_at) +
      '\nCreated by ' + personName(t.creator) + ' on ' + fullTime(t.created_at) +
      '\nVersion ' + t.version;
    tr.appendChild(tdEd);

    var tdAct = el('td', 'col-actions');
    var editBtn = el('button', 'icon-btn', '✎');
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', function () { openModal('edit', t); });
    var delBtn = el('button', 'icon-btn danger', '🗑');
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', function () { onDelete(t); });
    tdAct.appendChild(editBtn);
    tdAct.appendChild(delBtn);
    tr.appendChild(tdAct);

    return tr;
  }

  function renderCategoryFilter() {
    var selEl = $('filter-category');
    var current = selEl.value;
    var cats = state.categories;
    if (!isAdmin()) {
      cats = cats.filter(function (c) { return myPerm(c.id).can_view; });
    }
    selEl.replaceChildren();
    var all = el('option', null, 'All categories');
    all.value = '';
    selEl.appendChild(all);
    cats.forEach(function (c) {
      var o = el('option', null, c.name);
      o.value = c.id;
      selEl.appendChild(o);
    });
    // keep the current filter if that category is still listed
    selEl.value = cats.some(function (c) { return c.id === current; }) ? current : '';
  }

  function renderAssignedFilter() {
    var selEl = $('filter-assigned');
    var current = selEl.value;
    selEl.replaceChildren();
    var all = el('option', null, 'All assignees');
    all.value = '';
    selEl.appendChild(all);
    var everyone = el('option', null, 'Everyone (whole team)');
    everyone.value = '__everyone__';
    selEl.appendChild(everyone);
    state.profiles.forEach(function (p) {
      var o = el('option', null, p.display_name + (p.id === state.user.id ? ' (me)' : ''));
      o.value = p.id;
      selEl.appendChild(o);
    });
    var valid = current === '__everyone__' ||
      state.profiles.some(function (p) { return p.id === current; });
    selEl.value = valid ? current : '';
  }

  function updateAdminUi() {
    $('btn-categories').classList.toggle('hidden', !isAdmin());
    $('btn-admin').classList.toggle('hidden', !isAdmin());
    if (!isAdmin() && catModal.open) closeCatModal();
    if (!isAdmin() && adminModal.open) closeAdminModal();
    var meta = (state.user && state.user.user_metadata) || {};
    var name = (state.myProfile && state.myProfile.display_name) || meta.display_name || (state.user && state.user.email) || '';
    $('me-label').textContent = name + (isAdmin() ? ' · admin' : '');
  }

  // ---------- category manager (admins): add + rename ----------

  var catModal = { open: false, editingId: null };

  function openCatModal() {
    catModal.open = true;
    catModal.editingId = null;
    $('cat-new-name').value = '';
    $('cat-modal-backdrop').classList.remove('hidden');
    renderCatModal();
    $('cat-new-name').focus();
  }

  function closeCatModal() {
    catModal.open = false;
    catModal.editingId = null;
    $('cat-modal-backdrop').classList.add('hidden');
  }

  function renderCatModal() {
    var list = $('cat-list');
    list.replaceChildren();
    if (state.categories.length === 0) {
      list.appendChild(el('div', 'msel-empty', 'No categories yet — add the first one above.'));
      return;
    }
    state.categories.forEach(function (c) {
      list.appendChild(catModal.editingId === c.id ? renderCatEditRow(c) : renderCatRow(c));
    });
  }

  function renderCatRow(c) {
    var row = el('div', 'cat-row');
    row.appendChild(el('span', 'cat-name', c.name));
    var count = state.todos.filter(function (t) {
      return (t.category_ids || []).indexOf(c.id) >= 0;
    }).length;
    row.appendChild(el('span', 'muted small cat-count',
      count + (count === 1 ? ' record' : ' records')));
    var edit = el('button', 'icon-btn', '✎');
    edit.type = 'button';
    edit.title = 'Rename';
    edit.addEventListener('click', function () {
      catModal.editingId = c.id;
      renderCatModal();
    });
    row.appendChild(edit);
    return row;
  }

  function renderCatEditRow(c) {
    var row = el('div', 'cat-row editing');
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.value = c.name;
    var save = el('button', 'btn primary btn-small', 'Save');
    save.type = 'button';
    var cancel = el('button', 'btn ghost btn-small', 'Cancel');
    cancel.type = 'button';
    save.addEventListener('click', function () { saveCatRename(c, input, save); });
    cancel.addEventListener('click', function () { catModal.editingId = null; renderCatModal(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveCatRename(c, input, save); }
      if (e.key === 'Escape') { e.stopPropagation(); catModal.editingId = null; renderCatModal(); }
    });
    row.appendChild(input);
    row.appendChild(save);
    row.appendChild(cancel);
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return row;
  }

  function catError(err, action) {
    var msg = (err && err.message) || '';
    if (err && (err.code === '42501' || /row-level security/i.test(msg))) {
      toast('Only admins can ' + action + ' categories.', 'warn', 5000);
    } else if (err && err.code === '23505') {
      toast('That name is already used by another category.', 'warn', 5000);
    } else if (err && err.code === 'PGRST116') {
      toast('Could not ' + action + ' — the category may have been deleted, or you are not an admin.', 'warn', 6000);
    } else {
      toast('Could not ' + action + ' category: ' + msg, 'error', 6000);
    }
  }

  async function saveNewCategory() {
    var input = $('cat-new-name');
    var name = input.value.trim();
    if (!name) return;
    var btn = $('btn-cat-add');
    btn.disabled = true;
    try {
      var res = await sb.from('categories').insert({ name: name }).select('id, name').single();
      if (res.error) throw res.error;
      state.categories.push(res.data);
      state.categories.sort(function (a, b) { return a.name.localeCompare(b.name); });
      input.value = '';
      renderCatModal();
      renderCategoryFilter();
      toast('Category "' + res.data.name + '" added', 'ok');
      input.focus();
    } catch (err) {
      catError(err, 'add');
    } finally {
      btn.disabled = false;
    }
  }

  // Rename: records reference categories by id, so the new name shows up
  // on every record, chip, and filter the moment it saves.
  async function saveCatRename(c, input, btn) {
    var name = input.value.trim();
    if (!name) return;
    if (name === c.name) { catModal.editingId = null; renderCatModal(); return; }
    btn.disabled = true;
    try {
      var res = await sb.from('categories').update({ name: name }).eq('id', c.id).select('id, name').single();
      if (res.error) throw res.error;
      var i = state.categories.findIndex(function (x) { return x.id === c.id; });
      if (i >= 0) state.categories[i] = res.data;
      state.categories.sort(function (a, b) { return a.name.localeCompare(b.name); });
      catModal.editingId = null;
      renderCatModal();
      renderCategoryFilter();
      render(); // chips on existing records pick up the new name
      toast('Renamed to "' + res.data.name + '" — updated on every record using it', 'ok');
    } catch (err) {
      catError(err, 'rename');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- multi-select dropdowns (assigned / visible / categories) ----------

  var MSELS = {
    assigned: {
      items: function () { return state.profiles.map(function (p) { return { id: p.id, label: p.display_name }; }); },
      summary: function (set) { return summarizePeople(set, 'Everyone'); },
      empty: 'No team members found.',
      // Nobody ticked = assigned to the whole team. The panel shows an
      // "Everyone" row that is on by default; ticking a person replaces it.
      everyoneRow: 'Everyone (whole team)',
    },
    visible: {
      items: function () { return state.profiles.map(function (p) { return { id: p.id, label: p.display_name }; }); },
      summary: function (set) { return summarizePeople(set, 'Everyone'); },
      empty: 'No team members found.',
    },
    cats: {
      // Non-admins can only tag records with categories they hold
      // "can create" permission for (the database enforces it too).
      items: function () {
        var cats = state.categories;
        if (!isAdmin()) {
          cats = cats.filter(function (c) { return myPerm(c.id).can_create; });
        }
        return cats.map(function (c) { return { id: c.id, label: c.name }; });
      },
      summary: function (set) {
        if (set.size === 0) return 'None';
        var names = Array.from(set).map(categoryName).filter(Boolean);
        return names.length <= 2 ? names.join(', ') : names.length + ' categories';
      },
      empty: function () {
        return state.categories.length === 0
          ? 'No categories yet. An admin can add them via the "Categories…" button on the main screen.'
          : 'You do not have permission to create records in any category. An admin can grant access in the Admin area.';
      },
    },
  };

  function summarizePeople(set, emptyLabel) {
    if (set.size === 0) return emptyLabel;
    var names = Array.from(set).map(profileName);
    return names.length <= 2 ? names.join(', ') : names.length + ' people';
  }

  function buildMselPanel(key) {
    var cfg = MSELS[key];
    var panel = $('msel-panel-' + key);
    var selected = state.modal.sel[key];
    panel.replaceChildren();
    var items = cfg.items();
    if (items.length === 0) {
      panel.appendChild(el('div', 'msel-empty',
        typeof cfg.empty === 'function' ? cfg.empty() : cfg.empty));
      return;
    }
    if (cfg.everyoneRow) {
      var erow = el('label', 'msel-row msel-everyone');
      var ecb = document.createElement('input');
      ecb.type = 'checkbox';
      ecb.checked = selected.size === 0;
      ecb.addEventListener('change', function () {
        selected.clear();               // ticking Everyone clears individual picks;
        buildMselPanel(key);            // unticking with nobody picked stays Everyone
        updateMselSummary(key);
      });
      erow.appendChild(ecb);
      erow.appendChild(el('span', null, cfg.everyoneRow));
      panel.appendChild(erow);
    }
    items.forEach(function (item) {
      var row = el('label', 'msel-row');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(item.id);
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(item.id); else selected.delete(item.id);
        if (cfg.everyoneRow) buildMselPanel(key); // keep the Everyone row in sync
        updateMselSummary(key);
      });
      row.appendChild(cb);
      row.appendChild(el('span', null, item.label));
      panel.appendChild(row);
    });
  }

  function updateMselSummary(key) {
    $('msel-btn-' + key).textContent = MSELS[key].summary(state.modal.sel[key]);
  }

  function closeAllPanels() {
    var open = document.querySelectorAll('.msel-panel:not(.hidden)');
    open.forEach(function (p) { p.classList.add('hidden'); });
    return open.length > 0;
  }

  function toggleMselPanel(key) {
    var panel = $('msel-panel-' + key);
    var wasOpen = !panel.classList.contains('hidden');
    closeAllPanels();
    if (!wasOpen) {
      buildMselPanel(key); // rebuild from latest data each time it opens
      panel.classList.remove('hidden');
    }
  }

  // ---------- inline status change ----------

  async function onInlineStatusChange(id, version, sel) {
    sel.disabled = true;
    try {
      var res = await saveWithVersionCheck(id, version, { status: sel.value });
      if (res.ok) { upsertLocal(res.ok); return; }
      if (res.conflict === 'deleted') {
        removeLocal(id);
        toast('Status not saved — this record was deleted by someone else.', 'warn', 6000);
      } else {
        upsertLocal(res.current);
        toast('Status not saved — ' + personName(res.current.editor) +
          ' changed this record after you loaded it. The row now shows their version; try again.', 'warn', 7000);
      }
    } catch (err) {
      toast('Could not save: ' + err.message, 'error', 6000);
      render(); // snap the select back to the real value
    } finally {
      sel.disabled = false;
    }
  }

  // ---------- delete ----------

  async function onDelete(t) {
    var ok = window.confirm('Delete "' + t.title + '"?\nThis removes it (and its attachments) for the whole team.');
    if (!ok) return;
    try {
      // List attachments BEFORE deleting the record - reading them is only
      // allowed while the record still exists.
      var files = [];
      var lr = await sb.storage.from('attachments').list(t.id, { limit: 100 });
      if (!lr.error && lr.data) {
        files = lr.data.map(function (f) { return t.id + '/' + f.name; });
      }
      var res = await deleteWithVersionCheck(t.id, t.version);
      if (res.ok) {
        if (files.length) sb.storage.from('attachments').remove(files); // best-effort cleanup
        removeLocal(t.id);
        toast(res.already ? 'It was already deleted by someone else.' : 'Record deleted', 'ok');
      } else {
        upsertLocal(res.current);
        toast('Not deleted — ' + personName(res.current.editor) +
          ' changed this record after you loaded it. Check their change, then delete again if you still want to.',
          'warn', 8000);
      }
    } catch (err) {
      toast('Could not delete: ' + err.message, 'error', 6000);
    }
  }

  // ---------- add / edit modal ----------

  function setModalError(msg) {
    var e = $('modal-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function hideConflict() {
    $('conflict-banner').classList.add('hidden');
  }

  function updateModalMeta(t) {
    $('modal-meta').textContent = !t ? '' :
      'Created by ' + personName(t.creator) + ' ' + relTime(t.created_at) +
      ' · last edited by ' + personName(t.editor) + ' ' + relTime(t.updated_at) +
      ' · version ' + t.version;
  }

  function openModal(mode, t) {
    state.modal = {
      mode: mode,
      id: t ? t.id : null,
      version: t ? t.version : null,
      current: null,
      sel: {
        assigned: new Set(t ? (t.assigned_to || []) : []),
        visible: new Set(t ? (t.visible_to || []) : []),
        cats: new Set(t ? (t.category_ids || []) : []),
      },
    };
    $('modal-title').textContent = mode === 'create' ? 'New record' : 'Edit record';
    $('rec-title').value = t ? t.title : '';
    $('rec-description').value = t ? (t.description || '') : '';
    $('rec-notes').value = t ? t.notes : '';
    $('rec-status').value = t ? t.status : 'open';
    $('rec-priority').value = t ? t.priority : 'normal';
    $('rec-due').value = (t && t.due_date) ? t.due_date : '';
    closeAllPanels();
    Object.keys(MSELS).forEach(updateMselSummary);
    setModalError(null);
    hideConflict();
    updateModalMeta(t || null);
    state.modal.attachments = [];
    $('btn-attach').disabled = mode !== 'edit';
    $('attach-hint').classList.toggle('hidden', mode === 'edit');
    renderAttachments();
    if (mode === 'edit') loadAttachments();
    $('btn-save').textContent = 'Save';
    $('modal-backdrop').classList.remove('hidden');
    autoGrowAll(); // must run while visible, or scrollHeight reads 0
    $('rec-title').focus();
  }

  // Description and Notes grow with their content instead of scrolling
  // inside a fixed box. On a phone the modal is full-screen and scrolls, so
  // long text stays readable rather than trapped behind a tiny inner bar.
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function autoGrowAll() {
    autoGrow($('rec-title'));
    autoGrow($('rec-description'));
    autoGrow($('rec-notes'));
  }

  function closeModal() {
    closeAllPanels();
    state.modal = null;
    $('modal-backdrop').classList.add('hidden');
  }

  // Someone saved a newer version while this user had the form open.
  // Their edits stay in the form; we adopt the new version number so that
  // pressing Save again is an informed overwrite, never a silent one.
  function showConflict(current) {
    state.modal.version = current.version;
    state.modal.current = current;
    updateModalMeta(current);
    $('conflict-text').textContent =
      '⚠ This record was changed by ' + personName(current.editor) + ' (' +
      relTime(current.updated_at) + ') while you were editing. Your edits have NOT been saved. ' +
      'Press "Save anyway" to replace their version with yours, or discard your edits below.';
    $('conflict-actions').classList.remove('hidden');
    $('conflict-banner').classList.remove('hidden');
    $('btn-save').textContent = 'Save anyway';
  }

  function showDeletedNotice() {
    $('conflict-text').textContent =
      '⚠ This record was deleted by someone else while you were editing. ' +
      'Saving will re-create it as a new record.';
    $('conflict-actions').classList.add('hidden');
    $('conflict-banner').classList.remove('hidden');
    $('btn-save').textContent = 'Save as new';
    state.modal.attachments = [];
    $('btn-attach').disabled = true;
    renderAttachments();
  }

  // ---------- attachments (stored in the private "attachments" bucket
  // under <record id>/<filename>; access follows record visibility) ----------

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function displayFileName(name) {
    return name.replace(/^\d{10,}_/, ''); // hide the upload-timestamp prefix
  }

  async function loadAttachments() {
    var m = state.modal;
    if (!m || m.mode !== 'edit' || !m.id) return;
    var res = await sb.storage.from('attachments').list(m.id, {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (res.error) {
      console.log('[app] attachments list failed: ' + res.error.message);
      return;
    }
    if (!state.modal || state.modal.id !== m.id) return; // modal moved on meanwhile
    state.modal.attachments = res.data || [];
    renderAttachments();
  }

  function renderAttachments() {
    var list = $('attach-list');
    list.replaceChildren();
    var m = state.modal;
    if (!m) return;
    var files = m.attachments || [];
    files.forEach(function (f) {
      var row = el('div', 'attach-row');
      var name = el('a', 'attach-name', displayFileName(f.name));
      name.href = '#';
      name.title = 'Open / download';
      name.addEventListener('click', function (e) {
        e.preventDefault();
        openAttachment(m.id, f.name);
      });
      row.appendChild(name);
      row.appendChild(el('span', 'attach-size muted small', fmtSize(f.metadata && f.metadata.size)));
      var del = el('button', 'icon-btn danger', '✕');
      del.type = 'button';
      del.title = 'Delete attachment';
      del.addEventListener('click', function () { deleteAttachment(m.id, f.name); });
      row.appendChild(del);
      list.appendChild(row);
    });
    if (files.length === 0 && m.mode === 'edit') {
      list.appendChild(el('div', 'muted small', 'No attachments yet.'));
    }
  }

  async function uploadAttachments(files) {
    var m = state.modal;
    if (!m || m.mode !== 'edit' || !m.id) return;
    var status = el('div', 'attach-uploading', 'Uploading…');
    $('attach-list').prepend(status);
    var failed = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      status.textContent = 'Uploading ' + f.name + ' (' + (i + 1) + '/' + files.length + ')…';
      if (f.size > 25 * 1024 * 1024) {
        failed.push(f.name + ' (over the 25 MB limit)');
        continue;
      }
      var safe = f.name.replace(/[^\w.\-()]+/g, '_');
      var res = await sb.storage.from('attachments').upload(m.id + '/' + Date.now() + '_' + safe, f);
      if (res.error) failed.push(f.name + ' (' + res.error.message + ')');
    }
    await loadAttachments();
    if (failed.length) {
      toast('Could not upload: ' + failed.join('; '), 'error', 8000);
    } else {
      toast(files.length === 1 ? 'File attached' : files.length + ' files attached', 'ok');
    }
  }

  var IS_ELECTRON = navigator.userAgent.indexOf('Electron') >= 0;

  async function openAttachment(todoId, name) {
    if (IS_ELECTRON) {
      var res = await sb.storage.from('attachments').createSignedUrl(todoId + '/' + name, 300);
      if (res.error) {
        toast('Could not open file: ' + res.error.message, 'error', 6000);
        return;
      }
      window.open(res.data.signedUrl); // the main process sends this to the OS browser
      return;
    }
    // Browsers (especially iOS Safari) block window.open after an await, so
    // open the tab synchronously and point it at the signed URL once it
    // arrives.
    var w = window.open('about:blank');
    var res2 = await sb.storage.from('attachments').createSignedUrl(todoId + '/' + name, 300);
    if (res2.error) {
      if (w) w.close();
      toast('Could not open file: ' + res2.error.message, 'error', 6000);
      return;
    }
    if (w) w.location.href = res2.data.signedUrl;
    else window.location.href = res2.data.signedUrl;
  }

  async function deleteAttachment(todoId, name) {
    if (!window.confirm('Delete attachment "' + displayFileName(name) + '"?')) return;
    var res = await sb.storage.from('attachments').remove([todoId + '/' + name]);
    if (res.error) {
      toast('Could not delete: ' + res.error.message, 'error', 6000);
      return;
    }
    toast('Attachment deleted', 'ok');
    loadAttachments();
  }

  // ---------- admin area (users, credentials, category access) ----------

  var adminModal = { open: false, pwEditId: null, nameEditId: null };

  function genPassword() {
    var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var out = '';
    var buf = new Uint32Array(14);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  function setAdminError(msg) {
    var e = $('au-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function openAdminModal() {
    adminModal.open = true;
    adminModal.pwEditId = null;
    adminModal.nameEditId = null;
    $('au-first').value = '';
    $('au-last').value = '';
    $('au-email').value = '';
    $('au-pass').value = genPassword();
    $('au-role').value = 'user';
    setAdminError(null);
    $('admin-backdrop').classList.remove('hidden');
    renderAdminUsers();
  }

  function closeAdminModal() {
    adminModal.open = false;
    adminModal.pwEditId = null;
    adminModal.nameEditId = null;
    $('admin-backdrop').classList.add('hidden');
  }

  function renderAdminUsers() {
    var wrap = $('admin-users');
    wrap.replaceChildren();
    state.profiles.forEach(function (p) { wrap.appendChild(renderAdminUser(p)); });
  }

  function renderAdminUser(p) {
    var card = el('div', 'admin-user');
    var head = el('div', 'admin-user-head');
    head.appendChild(el('span', 'admin-user-name',
      p.display_name + (p.id === state.user.id ? ' (you)' : '')));
    head.appendChild(el('span', 'muted small', p.email));
    head.appendChild(el('span', 'role-badge', p.role));
    head.appendChild(el('span', 'spacer'));

    var roleSel = el('select');
    ['user', 'admin'].forEach(function (r) {
      var o = el('option', null, r === 'admin' ? 'Admin' : 'User');
      o.value = r;
      if (p.role === r) o.selected = true;
      roleSel.appendChild(o);
    });
    roleSel.title = 'Change role';
    roleSel.addEventListener('change', function () { changeRole(p, roleSel); });
    head.appendChild(roleSel);

    var nameBtn = el('button', 'btn ghost btn-small', 'Rename');
    nameBtn.type = 'button';
    nameBtn.addEventListener('click', function () {
      adminModal.nameEditId = adminModal.nameEditId === p.id ? null : p.id;
      adminModal.pwEditId = null;
      renderAdminUsers();
    });
    head.appendChild(nameBtn);

    var pwBtn = el('button', 'btn ghost btn-small', 'Reset password');
    pwBtn.type = 'button';
    pwBtn.addEventListener('click', function () {
      adminModal.pwEditId = adminModal.pwEditId === p.id ? null : p.id;
      adminModal.nameEditId = null;
      renderAdminUsers();
    });
    head.appendChild(pwBtn);
    card.appendChild(head);

    if (adminModal.nameEditId === p.id) {
      var nrow = el('div', 'pw-row');
      var firstIn = document.createElement('input');
      firstIn.type = 'text';
      firstIn.maxLength = 40;
      firstIn.placeholder = 'First name';
      firstIn.value = p.first_name || '';
      var lastIn = document.createElement('input');
      lastIn.type = 'text';
      lastIn.maxLength = 40;
      lastIn.placeholder = 'Last name';
      lastIn.value = p.last_name || '';
      var nsave = el('button', 'btn primary btn-small', 'Save name');
      nsave.type = 'button';
      nsave.addEventListener('click', function () { saveName(p, firstIn, lastIn, nsave); });
      var ncancel = el('button', 'btn ghost btn-small', 'Cancel');
      ncancel.type = 'button';
      ncancel.addEventListener('click', function () {
        adminModal.nameEditId = null;
        renderAdminUsers();
      });
      nrow.appendChild(firstIn);
      nrow.appendChild(lastIn);
      nrow.appendChild(nsave);
      nrow.appendChild(ncancel);
      card.appendChild(nrow);
    }

    if (adminModal.pwEditId === p.id) {
      var row = el('div', 'pw-row');
      var input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = genPassword();
      var save = el('button', 'btn primary btn-small', 'Set password');
      save.type = 'button';
      save.addEventListener('click', function () { savePassword(p, input, save); });
      var cancel = el('button', 'btn ghost btn-small', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        adminModal.pwEditId = null;
        renderAdminUsers();
      });
      row.appendChild(input);
      row.appendChild(save);
      row.appendChild(cancel);
      card.appendChild(row);
    }

    if (p.role === 'admin') {
      card.appendChild(el('div', 'muted small', 'Admins can always see everything and use every category.'));
    } else if (state.categories.length === 0) {
      card.appendChild(el('div', 'muted small', 'Category access appears here once categories exist.'));
    } else {
      card.appendChild(renderPermTable(p));
    }
    return card;
  }

  function renderPermTable(p) {
    var table = el('table', 'perm-table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'Category'));
    hr.appendChild(el('th', null, 'Can view'));
    hr.appendChild(el('th', null, 'Can create'));
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    state.categories.forEach(function (c) {
      var perm = permsFor(p.id, c.id);
      var tr = el('tr');
      tr.appendChild(el('td', 'perm-cat-name', c.name));
      tr.appendChild(permCell(p, c, perm, 'can_view'));
      tr.appendChild(permCell(p, c, perm, 'can_create'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function permCell(p, c, perm, field) {
    var td = el('td');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!perm[field];
    cb.addEventListener('change', function () { setPerm(p, c, field, cb.checked, cb); });
    td.appendChild(cb);
    return td;
  }

  async function setPerm(p, c, field, value, cb) {
    cb.disabled = true;
    var cur = permsFor(p.id, c.id);
    var row = { user_id: p.id, category_id: c.id, can_view: cur.can_view, can_create: cur.can_create };
    row[field] = value;
    if (field === 'can_create' && value) row.can_view = true;    // creating implies seeing
    if (field === 'can_view' && !value) row.can_create = false;  // hiding removes create too
    try {
      var res = await sb.from('category_permissions').upsert(row);
      if (res.error) throw res.error;
      var i = state.perms.findIndex(function (x) {
        return x.user_id === p.id && x.category_id === c.id;
      });
      if (i >= 0) state.perms[i] = row; else state.perms.push(row);
    } catch (err) {
      toast('Could not save permission: ' + err.message, 'error', 6000);
    }
    renderAdminUsers();
  }

  async function changeRole(p, sel) {
    sel.disabled = true;
    try {
      var res = await sb.rpc('admin_set_role', { p_user_id: p.id, p_role: sel.value });
      if (res.error) throw res.error;
      toast(p.display_name + ' is now ' + (sel.value === 'admin' ? 'an admin' : 'a regular user'), 'ok');
      await reload(true);
    } catch (err) {
      toast('Could not change role: ' + err.message, 'error', 7000);
    }
    renderAdminUsers();
  }

  async function savePassword(p, input, btn) {
    var pw = input.value.trim();
    if (pw.length < 8) {
      toast('Password must be at least 8 characters.', 'warn', 5000);
      return;
    }
    btn.disabled = true;
    try {
      var res = await sb.rpc('admin_set_password', { p_user_id: p.id, p_password: pw });
      if (res.error) throw res.error;
      adminModal.pwEditId = null;
      renderAdminUsers();
      toast('Password set for ' + p.display_name + ' — tell them the new password.', 'ok', 6000);
    } catch (err) {
      toast('Could not set password: ' + err.message, 'error', 7000);
      btn.disabled = false;
    }
  }

  async function saveName(p, firstIn, lastIn, btn) {
    var first = firstIn.value.trim();
    var last = lastIn.value.trim();
    if (!first && !last) { toast('Enter at least a first name.', 'warn', 5000); return; }
    btn.disabled = true;
    try {
      var res = await sb.rpc('admin_set_name', {
        p_user_id: p.id, p_first_name: first, p_last_name: last,
      });
      if (res.error) throw res.error;
      adminModal.nameEditId = null;
      toast('Name updated', 'ok');
      await reload(true);
      renderAdminUsers();
    } catch (err) {
      toast('Could not rename: ' + err.message, 'error', 7000);
      btn.disabled = false;
    }
  }

  async function addUser() {
    var first = $('au-first').value.trim();
    var last = $('au-last').value.trim();
    var email = $('au-email').value.trim();
    var pass = $('au-pass').value;
    setAdminError(null);
    if (!email || email.indexOf('@') < 0) { setAdminError('Enter a valid email address.'); return; }
    if (pass.length < 8) { setAdminError('Password must be at least 8 characters.'); return; }
    var btn = $('au-add');
    btn.disabled = true;
    try {
      var res = await sb.rpc('admin_create_user', {
        p_email: email,
        p_password: pass,
        p_first_name: first || null,
        p_last_name: last || null,
        p_role: $('au-role').value,
      });
      if (res.error) throw res.error;
      toast('User added — tell them to sign in with ' + email.toLowerCase() +
        ' and the password you set.', 'ok', 8000);
      $('au-first').value = '';
      $('au-last').value = '';
      $('au-email').value = '';
      $('au-pass').value = genPassword();
      $('au-role').value = 'user';
      await reload(true);
      renderAdminUsers();
    } catch (err) {
      setAdminError(err.message || 'Could not add user.');
    } finally {
      btn.disabled = false;
    }
  }

  async function onModalSave(e) {
    e.preventDefault();
    var m = state.modal;
    if (!m) return;

    var title = $('rec-title').value.trim();
    if (!title) { setModalError('Title is required.'); return; }
    var fields = {
      title: title,
      description: $('rec-description').value,
      notes: $('rec-notes').value,
      status: $('rec-status').value,
      priority: $('rec-priority').value,
      due_date: $('rec-due').value || null,
      assigned_to: Array.from(m.sel.assigned),
      visible_to: Array.from(m.sel.visible),
      category_ids: Array.from(m.sel.cats),
    };

    var btn = $('btn-save');
    btn.disabled = true;
    setModalError(null);
    try {
      if (m.mode === 'create') {
        var ins = await sb.from('todos').insert(fields).select(TODO_SELECT).single();
        if (ins.error) throw ins.error;
        upsertLocal(ins.data);
        closeModal();
        toast('Record added', 'ok');
      } else {
        var res = await saveWithVersionCheck(m.id, m.version, fields);
        if (res.ok) {
          upsertLocal(res.ok);
          closeModal();
          toast('Saved', 'ok');
        } else if (res.conflict === 'deleted') {
          removeLocal(m.id);
          m.mode = 'create'; m.id = null; m.version = null; m.current = null;
          $('modal-title').textContent = 'New record';
          updateModalMeta(null);
          showDeletedNotice();
        } else {
          upsertLocal(res.current); // the table behind the modal shows their version
          showConflict(res.current);
        }
      }
    } catch (err) {
      setModalError('Could not save: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- live updates ----------

  function scheduleReload() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(function () { reload(false); }, 250);
  }

  function setLive(on) {
    $('live-dot').classList.toggle('off', !on);
    $('live-label').textContent = on ? 'live' : 'offline';
    $('live-label').title = on
      ? 'Connected — other people’s changes appear automatically'
      : 'Live updates unavailable — use Refresh';
  }

  function connectRealtime() {
    disconnectRealtime();
    state.channel = sb
      .channel('todos-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, function (payload) {
        console.log('[app] realtime todos: ' + payload.eventType);
        scheduleReload();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, function (payload) {
        console.log('[app] realtime categories: ' + payload.eventType);
        scheduleReload();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'category_permissions' }, function (payload) {
        console.log('[app] realtime permissions: ' + payload.eventType);
        scheduleReload();
      })
      .subscribe(function (status) {
        console.log('[app] realtime status: ' + status);
        setLive(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') scheduleReload(); // catch anything missed while connecting
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && state.user) {
          clearTimeout(state.retryTimer);
          state.retryTimer = setTimeout(function () {
            if (state.user) connectRealtime();
          }, 5000);
        }
      });
  }

  function disconnectRealtime() {
    if (state.channel) {
      sb.removeChannel(state.channel);
      state.channel = null;
    }
    setLive(false);
  }

  // ---------- lifecycle (called by auth.js) ----------

  async function start(user) {
    state.user = user;
    var meta = user.user_metadata || {};
    $('me-label').textContent = meta.display_name || user.email;
    $('count-label').textContent = 'Loading…';
    console.log('[app] started for ' + user.email);
    await reload(true);
    connectRealtime();
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(function () {
      if (state.user && !document.hidden) render(); // keep "5 min ago" fresh
    }, 60000);
  }

  function stop() {
    state.user = null;
    state.myProfile = null;
    disconnectRealtime();
    clearTimeout(state.reloadTimer);
    clearTimeout(state.retryTimer);
    clearInterval(state.clockTimer);
    state.todos = [];
    state.profiles = [];
    state.categories = [];
    state.perms = [];
    closeModal();
    closeCatModal();
    closeAdminModal();
    $('btn-categories').classList.add('hidden');
    $('btn-admin').classList.add('hidden');
    console.log('[app] stopped');
  }

  window.todoApp = { start: start, stop: stop };

  // ---------- static event wiring ----------

  if (sb) {
    $('btn-new').addEventListener('click', function () { openModal('create', null); });
    $('btn-refresh').addEventListener('click', function () { reload(true); });
    $('record-form').addEventListener('submit', onModalSave);
    $('btn-cancel').addEventListener('click', closeModal);
    $('modal-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (closeAllPanels()) return;              // first Escape closes an open dropdown
        if (catModal.open) { closeCatModal(); return; }
        if (adminModal.open) { closeAdminModal(); return; }
        if (state.modal) closeModal();             // next one closes the modal
      }
    });
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest || !e.target.closest('.msel')) closeAllPanels();
    });
    Object.keys(MSELS).forEach(function (key) {
      $('msel-btn-' + key).addEventListener('click', function () { toggleMselPanel(key); });
    });
    $('conflict-load-theirs').addEventListener('click', function (e) {
      e.preventDefault();
      var c = state.modal && state.modal.current;
      if (c) openModal('edit', c); // re-fills the form and clears the banner
    });
    $('btn-admin').addEventListener('click', openAdminModal);
    $('btn-admin-close').addEventListener('click', closeAdminModal);
    $('admin-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeAdminModal();
    });
    $('au-add').addEventListener('click', addUser);
    $('au-gen').addEventListener('click', function (e) {
      e.preventDefault();
      $('au-pass').value = genPassword();
    });
    $('btn-attach').addEventListener('click', function () { $('attach-input').click(); });
    $('attach-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call($('attach-input').files || []);
      $('attach-input').value = '';
      if (files.length) uploadAttachments(files);
    });
    $('btn-categories').addEventListener('click', openCatModal);
    $('btn-cat-add').addEventListener('click', saveNewCategory);
    $('btn-cat-close').addEventListener('click', closeCatModal);
    $('cat-modal-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeCatModal();
    });
    $('cat-new-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveNewCategory(); }
    });
    ['rec-description', 'rec-notes'].forEach(function (id) {
      $(id).addEventListener('input', function () { autoGrow($(id)); });
    });
    // The title wraps and grows like the other fields, but stays a single
    // line of text: flatten any line breaks that arrive by pasting.
    $('rec-title').addEventListener('input', function () {
      var el = $('rec-title');
      if (el.value.indexOf('\n') >= 0 || el.value.indexOf('\r') >= 0) {
        var pos = el.selectionStart;
        el.value = el.value.split(/\r\n|\r|\n/).join(' ');
        el.setSelectionRange(pos, pos);
      }
      autoGrow(el);
    });
    // Enter saves, exactly as it did when the title was a plain input.
    $('rec-title').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('btn-save').click();
      }
    });
    $('search-box').addEventListener('input', render);
    $('filter-status').addEventListener('change', render);
    $('filter-category').addEventListener('change', render);
    $('filter-assigned').addEventListener('change', render);
    window.addEventListener('online', function () {
      if (state.user) { reload(false); connectRealtime(); }
    });
    window.addEventListener('focus', function () {
      if (state.user) reload(false);
    });
  }
})();
