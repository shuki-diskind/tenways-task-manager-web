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

  var SHEET_PAGE = 200;   // rows fetched per request

  // Column widths are a personal preference, so they live in this browser
  // rather than in the shared sheet.
  function colWidthsKey() { return 'tenways.colw.' + state.currentTabId; }

  function loadColWidths() {
    try { return JSON.parse(window.localStorage.getItem(colWidthsKey()) || '{}'); }
    catch (e) { return {}; }
  }

  function saveColWidths() {
    try { window.localStorage.setItem(colWidthsKey(), JSON.stringify(state.colWidths)); }
    catch (e) { /* private mode */ }
  }

  function defaultColWidth(col) {
    if (col.kind === 'date') return 104;
    if (col.kind === 'number') return 72;
    if (col.kind === 'checkbox') return 72;
    if (col.kind === 'textarea') return 260;
    if (col.kind === 'picklist') return 140;
    return Math.min(260, Math.max(110, col.name.length * 9 + 30));
  }

  function colWidth(col) {
    var w = state.colWidths[col.key];
    return (typeof w === 'number' && w > 40) ? w : defaultColWidth(col);
  }

  var SHEET_ROW_SELECT = [
    'id', 'tab_id', 'position', 'data', 'version', 'created_at', 'updated_at',
    'created_by', 'updated_by',
    'editor:profiles!sheet_rows_updated_by_fkey(display_name,email)',
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
    tabs: [],           // every tab this user may see
    currentTabId: null, // which tab is on screen
    sheetCols: [],      // column definitions of the current sheet tab
    sheetRows: [],      // rows of the current sheet tab (paged)
    sheetTotal: 0,      // how many rows match on the server
    sheetQuery: '',     // the search the loaded rows belong to
    colWidths: {},      // per-tab column widths, remembered in this browser
    fullSheet: false,   // desktop: every row of the sheet is in memory
    renderToken: 0,     // cancels a chunked render superseded by a newer one
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

  // Whether the signed-in user may add/change/delete on the current tab.
  function canEditCurrentTab() {
    if (isAdmin()) return true;
    var t = currentTab();
    return !!(t && (t.editable_by || []).indexOf(state.user.id) >= 0);
  }

  function isPhone() { return window.matchMedia('(max-width: 720px)').matches; }

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

  function fetchTodos(tabId) {
    return sb.from('todos').select(TODO_SELECT)
      .eq('tab_id', tabId)
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

  function fetchCategories(tabId) {
    return sb.from('categories').select('id, name')
      .eq('tab_id', tabId)
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

  function fetchTabs() {
    return sb.from('tabs').select('id, name, kind, position, visible_to, editable_by, version')
      .order('position')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  function fetchSheetColumns(tabId) {
    return sb.from('sheet_columns').select('id, tab_id, key, name, kind, options, position')
      .eq('tab_id', tabId).order('position')
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
  }

  // Sheets are read through RPCs so the database does the searching and
  // paging; they run as the caller, so tab visibility still applies.
  // Phones page 200 rows at a time behind a "Load more" button; desktop pulls
  // the whole sheet up front (1000 rows per request) so scrolling and search
  // behave like a local spreadsheet.
  async function loadSheetRows(reset) {
    var tab = currentTab();
    if (!tab || tab.kind !== 'sheet') return;
    var q = $('sheet-search').value.trim();
    if (reset) {
      state.sheetRows = [];
      state.sheetQuery = q;
      state.fullSheet = false;
      var c = await sb.rpc('count_sheet_rows', { p_tab: tab.id, p_q: q });
      state.sheetTotal = c.error ? 0 : Number(c.data);
    }
    var page = isPhone() ? SHEET_PAGE : 1000;
    var res;
    do {
      res = await sb.rpc('search_sheet_rows', {
        p_tab: tab.id, p_q: q, p_limit: page, p_offset: state.sheetRows.length,
      });
      if (res.error) {
        toast('Could not load rows: ' + res.error.message, 'error', 6000);
        return;
      }
      state.sheetRows = state.sheetRows.concat(res.data || []);
      if (!isPhone() && state.sheetRows.length < state.sheetTotal) {
        $('count-label').textContent = 'Loading ' +
          state.sheetRows.length.toLocaleString() + ' / ' +
          state.sheetTotal.toLocaleString() + ' rows…';
      }
    } while (!isPhone() && state.sheetRows.length < state.sheetTotal &&
             (res.data || []).length > 0);
    // With everything in memory, search runs instantly on-device.
    state.fullSheet = q === '' && state.sheetRows.length >= state.sheetTotal;
    renderSheet();
  }

  var sheetSearchTimer = null;
  function onSheetSearch() {
    clearTimeout(sheetSearchTimer);
    if (state.fullSheet) {
      state.sheetQuery = $('sheet-search').value.trim();
      renderSheet();
      return;
    }
    sheetSearchTimer = setTimeout(function () { loadSheetRows(true); }, 350);
  }

  function rowMatchesQuery(row, q) {
    return state.sheetCols.some(function (c) {
      return sheetValue(row, c).toLowerCase().indexOf(q) >= 0;
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
      var base = await Promise.all([fetchTabs(), fetchProfiles(), fetchPerms()]);
      state.tabs = base[0];
      state.profiles = base[1];
      state.perms = base[2];
      state.myProfile = state.profiles.find(function (p) { return p.id === state.user.id; }) || null;
      ensureCurrentTab();

      var tab = currentTab();
      if (tab && tab.kind === 'sheet') {
        state.sheetCols = await fetchSheetColumns(tab.id);
        state.colWidths = loadColWidths();
        state.todos = [];
        state.categories = [];
        await loadSheetRows(true);
      } else {
        var t = tab
          ? await Promise.all([fetchTodos(tab.id), fetchCategories(tab.id)])
          : [[], []];
        state.todos = t[0];
        state.categories = t[1];
        state.sheetCols = [];
        state.sheetRows = [];
      }
      renderTabStrip();
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
    var tab = currentTab();
    var isSheet = !!(tab && tab.kind === 'sheet');
    $('tasks-view').classList.toggle('hidden', isSheet);
    $('sheet-view').classList.toggle('hidden', !isSheet);
    $('btn-new').classList.toggle('hidden', !canEditCurrentTab());
    if (isSheet) { renderSheet(); return; }

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
      var res = await sb.from('categories')
        .insert({ name: name, tab_id: state.currentTabId })
        .select('id, name').single();
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

  function mselSet(key) {
    return state.modal ? state.modal.sel[key] : new Set();
  }

  function buildMselPanel(key) {
    var cfg = MSELS[key];
    var panel = $('msel-panel-' + key);
    var selected = mselSet(key);
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
    $('msel-btn-' + key).textContent = MSELS[key].summary(mselSet(key));
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
    if (!canEditCurrentTab()) {
      toast('You have view-only access on this tab.', 'warn', 4000);
      render();
      return;
    }
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
    if (!canEditCurrentTab()) {
      toast('You have view-only access on this tab.', 'warn', 4000);
      return;
    }
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
    ['assigned', 'visible', 'cats'].forEach(updateMselSummary);
    setModalError(null);
    hideConflict();
    updateModalMeta(t || null);
    state.modal.attachments = [];
    $('btn-attach').disabled = mode !== 'edit';
    $('attach-hint').classList.toggle('hidden', mode === 'edit');
    renderAttachments();
    if (mode === 'edit') loadAttachments();
    $('btn-save').textContent = 'Save';
    $('btn-save').classList.toggle('hidden', !canEditCurrentTab());
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
    if (!canEditCurrentTab()) {
      e.preventDefault();
      setModalError('You have view-only access on this tab.');
      return;
    }
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
        fields.tab_id = state.currentTabId;
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tabs' }, function (payload) {
        console.log('[app] realtime tabs: ' + payload.eventType);
        scheduleReload();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sheet_rows' }, function (payload) {
        console.log('[app] realtime sheet rows: ' + payload.eventType);
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
    state.tabs = [];
    state.sheetCols = [];
    state.sheetRows = [];
    state.currentTabId = null;
    closeModal();
    closeRowModal();
    closeTabModal();
    closeCatModal();
    closeAdminModal();
    $('btn-categories').classList.add('hidden');
    $('btn-admin').classList.add('hidden');
    console.log('[app] stopped');
  }

  // Show which build is running - makes 'is my phone on the new version?'
  // answerable at a glance.
  (function showVersion() {
    var meta = document.querySelector('meta[name="app-version"]');
    var v = meta && meta.getAttribute('content');
    if (v && v !== '0.0.0') $('app-version').textContent = 'v' + v;
  })();

  // ---------- tabs ----------

  function currentTab() {
    return state.tabs.find(function (t) { return t.id === state.currentTabId; }) || null;
  }

  function ensureCurrentTab() {
    if (currentTab()) return;
    var remembered = null;
    try { remembered = window.localStorage.getItem('tenways.tab'); } catch (e) { /* private mode */ }
    var pick = state.tabs.find(function (t) { return t.id === remembered; }) || state.tabs[0] || null;
    state.currentTabId = pick ? pick.id : null;
  }

  function switchTab(id) {
    if (id === state.currentTabId) return;
    state.currentTabId = id;
    try { window.localStorage.setItem('tenways.tab', id); } catch (e) { /* private mode */ }
    $('search-box').value = '';
    $('sheet-search').value = '';
    state.sheetQuery = '';
    state.sheetTotal = 0;
    state.fullSheet = false;
    $('filter-status').value = '';
    reload(true);
  }

  function renderTabStrip() {
    var strip = $('tab-strip');
    strip.replaceChildren.apply(strip, state.tabs.map(function (t) {
      var b = el('button', 'tab-btn' + (t.id === state.currentTabId ? ' active' : ''), t.name);
      b.type = 'button';
      var team = state.profiles.filter(function (p) { return p.role !== 'admin'; });
      var excluded = team.some(function (p) { return (t.visible_to || []).indexOf(p.id) < 0; });
      if (excluded) {
        var lock = el('span', 'tab-lock', '\u{1F512}');
        var names = (t.visible_to || []).map(profileName).filter(Boolean);
        lock.title = names.length
          ? 'Only visible to: ' + names.join(', ') + ' (and admins)'
          : 'Only visible to admins';
        b.appendChild(lock);
      }
      b.addEventListener('click', function () { switchTab(t.id); });
      return b;
    }));
    $('btn-new-tab').classList.toggle('hidden', !isAdmin());
    $('btn-tab-settings').classList.toggle('hidden', !isAdmin() || !currentTab());
  }

  // ---------- tab settings (admins) ----------

  var tabModal = { open: false, mode: 'edit', view: new Set(), edit: new Set(),
    cols: [], deletedColIds: [] };

  var COL_KINDS = [
    ['text', 'Free text'],
    ['textarea', 'Free text (long)'],
    ['number', 'Number'],
    ['date', 'Date'],
    ['picklist', 'Dropdown list'],
    ['checkbox', 'Checkbox'],
    ['autonumber', 'Auto number'],
  ];

  function openTabModal(mode) {
    var t = currentTab();
    if (mode === 'edit' && !t) return;
    tabModal.open = true;
    tabModal.mode = mode;
    tabModal.view = new Set(mode === 'edit' ? (t.visible_to || []) : []);
    tabModal.edit = new Set(mode === 'edit' ? (t.editable_by || []) : []);
    tabModal.deletedColIds = [];
    tabModal.cols = (mode === 'edit' && t.kind === 'sheet')
      ? state.sheetCols.map(function (c) {
          return { id: c.id, key: c.key, name: c.name, kind: c.kind,
                   options: (c.options || []).slice() };
        })
      : [];
    $('tab-modal-title').textContent = mode === 'create' ? 'New tab' : 'Tab settings';
    $('tab-name').value = mode === 'edit' ? t.name : '';
    $('tab-kind-row').classList.toggle('hidden', mode !== 'create');
    $('tab-kind').value = 'tasks';
    $('btn-tab-delete').classList.toggle('hidden', mode !== 'edit');
    setTabError(null);
    renderTabPerms();
    updateTabColsVisibility();
    renderTabCols();
    $('tab-backdrop').classList.remove('hidden');
    $('tab-name').focus();
  }

  function tabModalKind() {
    return tabModal.mode === 'create' ? $('tab-kind').value
      : (currentTab() ? currentTab().kind : 'tasks');
  }

  function updateTabColsVisibility() {
    var isSheet = tabModalKind() === 'sheet';
    $('tab-cols-wrap').classList.toggle('hidden', !isSheet);
    var card = $('tab-backdrop').querySelector('.modal');
    if (card) card.classList.toggle('modal-wide', isSheet);
  }

  // Everyone on the team, two ticks each: view (read-only) and edit.
  function renderTabPerms() {
    var wrap = $('tab-perms');
    wrap.replaceChildren();
    var people = state.profiles.filter(function (p) { return p.role !== 'admin'; });
    if (people.length === 0) {
      wrap.appendChild(el('div', 'muted small',
        'Everyone on the team is an admin, so everyone already sees every tab.'));
      return;
    }
    var table = el('table', 'perm-table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'Team member'));
    hr.appendChild(el('th', null, 'Can view'));
    hr.appendChild(el('th', null, 'Can edit'));
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    people.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', 'perm-cat-name', p.display_name));
      var tdV = el('td');
      var cbV = document.createElement('input');
      cbV.type = 'checkbox';
      cbV.checked = tabModal.view.has(p.id);
      var tdE = el('td');
      var cbE = document.createElement('input');
      cbE.type = 'checkbox';
      cbE.checked = tabModal.edit.has(p.id);
      cbV.addEventListener('change', function () {
        if (cbV.checked) { tabModal.view.add(p.id); }
        else { tabModal.view.delete(p.id); tabModal.edit.delete(p.id); cbE.checked = false; }
      });
      cbE.addEventListener('change', function () {
        if (cbE.checked) { tabModal.edit.add(p.id); tabModal.view.add(p.id); cbV.checked = true; }
        else { tabModal.edit.delete(p.id); }
      });
      tdV.appendChild(cbV);
      tdE.appendChild(cbE);
      tr.appendChild(tdV);
      tr.appendChild(tdE);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ----- column editor (sheet tabs) -----

  function renderTabCols() {
    var wrap = $('tab-cols');
    wrap.replaceChildren();
    if (tabModal.cols.length === 0) {
      wrap.appendChild(el('div', 'muted small', 'No columns yet — add the first one below.'));
    }
    tabModal.cols.forEach(function (col, i) {
      var row = el('div', 'tab-cols-row');
      var up = el('button', 'btn ghost btn-small colmove', '\u2191');
      up.type = 'button';
      up.title = 'Move up';
      up.disabled = i === 0;
      up.addEventListener('click', function () {
        tabModal.cols.splice(i - 1, 0, tabModal.cols.splice(i, 1)[0]);
        renderTabCols();
      });
      var down = el('button', 'btn ghost btn-small colmove', '\u2193');
      down.type = 'button';
      down.title = 'Move down';
      down.disabled = i === tabModal.cols.length - 1;
      down.addEventListener('click', function () {
        tabModal.cols.splice(i + 1, 0, tabModal.cols.splice(i, 1)[0]);
        renderTabCols();
      });
      var name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 60;
      name.placeholder = 'Column name';
      name.value = col.name;
      name.addEventListener('input', function () { col.name = name.value; });
      var kind = document.createElement('select');
      COL_KINDS.forEach(function (k) {
        var o = el('option', null, k[1]);
        o.value = k[0];
        if (col.kind === k[0]) o.selected = true;
        kind.appendChild(o);
      });
      if (col.kind === 'contact') {   // legacy kind from older sheets
        var oc = el('option', null, 'Contact');
        oc.value = 'contact';
        oc.selected = true;
        kind.appendChild(oc);
      }
      kind.addEventListener('change', function () { col.kind = kind.value; renderTabCols(); });
      var del = el('button', 'btn ghost btn-small danger-text colmove', '\u2715');
      del.type = 'button';
      del.title = 'Remove this column';
      del.addEventListener('click', function () {
        if (col.id && !window.confirm('Remove the column "' + (col.name || '') + '"?\n\n' +
          'Its values stay stored but disappear from the sheet.')) return;
        if (col.id) tabModal.deletedColIds.push(col.id);
        tabModal.cols.splice(i, 1);
        renderTabCols();
      });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(name);
      row.appendChild(kind);
      row.appendChild(del);
      wrap.appendChild(row);
      if (col.kind === 'picklist') {
        var opts = document.createElement('textarea');
        opts.className = 'tab-cols-opts';
        opts.rows = Math.min(6, Math.max(2, (col.options || []).length));
        opts.placeholder = 'Dropdown choices — one per line';
        opts.value = (col.options || []).join('\n');
        opts.addEventListener('input', function () {
          col.options = opts.value.split(/\r\n|\r|\n/)
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
        });
        wrap.appendChild(opts);
      }
    });
  }

  function slugKey(name, taken) {
    var base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 40) || 'col';
    var key = base;
    var k = 2;
    while (taken.has(key)) { key = base + '_' + k; k++; }
    taken.add(key);
    return key;
  }

  // Applies the modal's column list: delete removed, update kept, insert new.
  // Positions follow the list order; renames keep the key, so data survives.
  async function saveTabColumns(tabId) {
    if (tabModal.deletedColIds.length > 0) {
      var d = await sb.from('sheet_columns').delete().in('id', tabModal.deletedColIds);
      if (d.error) throw d.error;
    }
    var taken = new Set(tabModal.cols.filter(function (c) { return c.key; })
      .map(function (c) { return c.key; }));
    var updates = [];
    var inserts = [];
    tabModal.cols.forEach(function (col, i) {
      var options = col.kind === 'picklist' ? (col.options || []) : [];
      if (col.id) {
        updates.push({ id: col.id, tab_id: tabId, key: col.key, name: col.name.trim(),
          kind: col.kind, options: options, position: i });
      } else {
        inserts.push({ tab_id: tabId, key: slugKey(col.name, taken), name: col.name.trim(),
          kind: col.kind, options: options, position: i });
      }
    });
    if (updates.length > 0) {
      var u = await sb.from('sheet_columns').upsert(updates);
      if (u.error) throw u.error;
    }
    if (inserts.length > 0) {
      var ins = await sb.from('sheet_columns').insert(inserts);
      if (ins.error) throw ins.error;
    }
  }

  function closeTabModal() {
    tabModal.open = false;
    closeAllPanels();
    $('tab-backdrop').classList.add('hidden');
  }

  function setTabError(msg) {
    var e = $('tab-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  async function saveTab() {
    var name = $('tab-name').value.trim();
    if (!name) { setTabError('Give the tab a name.'); return; }
    var btn = $('btn-tab-save');
    btn.disabled = true;
    setTabError(null);
    try {
      tabModal.edit.forEach(function (id) { tabModal.view.add(id); }); // edit implies view
      var kind = tabModalKind();
      if (kind === 'sheet') {
        var unnamed = tabModal.cols.find(function (c) { return !c.name.trim(); });
        if (unnamed) { setTabError('Every column needs a name.'); btn.disabled = false; return; }
        var noOpts = tabModal.cols.find(function (c) {
          return c.kind === 'picklist' && (c.options || []).length === 0;
        });
        if (noOpts) {
          setTabError('The dropdown column "' + noOpts.name + '" needs at least one choice.');
          btn.disabled = false;
          return;
        }
      }
      if (tabModal.mode === 'create') {
        var maxPos = state.tabs.reduce(function (m, t) { return Math.max(m, t.position || 0); }, -1);
        var ins = await sb.from('tabs').insert({
          name: name,
          kind: kind,
          position: maxPos + 1,
          visible_to: Array.from(tabModal.view),
          editable_by: Array.from(tabModal.edit),
        }).select('*').single();
        if (ins.error) throw ins.error;
        if (kind === 'sheet') await saveTabColumns(ins.data.id);
        state.currentTabId = ins.data.id;
        try { window.localStorage.setItem('tenways.tab', ins.data.id); } catch (e) { /* ignore */ }
        toast('Tab "' + ins.data.name + '" created', 'ok');
      } else {
        var t = currentTab();
        var upd = await sb.from('tabs')
          .update({ name: name, visible_to: Array.from(tabModal.view),
                    editable_by: Array.from(tabModal.edit) })
          .eq('id', t.id).eq('version', t.version).select('*');
        if (upd.error) throw upd.error;
        if (!upd.data || upd.data.length === 0) {
          setTabError('This tab was changed by someone else - reopen the settings and try again.');
          btn.disabled = false;
          await reload(false);
          return;
        }
        if (t.kind === 'sheet') await saveTabColumns(t.id);
        toast('Tab updated', 'ok');
      }
      closeTabModal();
      await reload(true);
    } catch (err) {
      setTabError(err.message || 'Could not save the tab.');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteTab() {
    var t = currentTab();
    if (!t) return;
    var what = t.kind === 'sheet' ? 'all of its rows and columns' : 'all of its records and categories';
    if (!window.confirm('Delete the tab "' + t.name + '"?\n\nThis permanently deletes ' + what +
      ' for the whole team. This cannot be undone.')) return;
    try {
      var res = await sb.from('tabs').delete().eq('id', t.id).select('id');
      if (res.error) throw res.error;
      state.currentTabId = null;
      try { window.localStorage.removeItem('tenways.tab'); } catch (e) { /* ignore */ }
      closeTabModal();
      toast('Tab deleted', 'ok');
      await reload(true);
    } catch (err) {
      setTabError(err.message || 'Could not delete the tab.');
    }
  }

  // ---------- sheet tabs ----------

  function sheetValue(row, col) {
    var v = row.data ? row.data[col.key] : null;
    if (v === null || v === undefined || v === '') return '';
    if (col.kind === 'checkbox') return (v === true || v === 'true') ? 'Yes' : 'No';
    if (col.kind === 'date') return formatDue(String(v).slice(0, 10)) || String(v);
    return String(v);
  }

  function renderSheet() {
    var cols = state.sheetCols;
    var rows = state.sheetRows;
    if (state.fullSheet && state.sheetQuery) {
      var q = state.sheetQuery.toLowerCase();
      rows = rows.filter(function (r) { return rowMatchesQuery(r, q); });
    }
    var head = $('sheet-head');
    var body = $('sheet-body');

    var searching = state.sheetQuery !== '';
    $('sheet-nocols').classList.toggle('hidden', cols.length > 0);
    $('sheet-empty').classList.toggle('hidden', !(cols.length > 0 && rows.length === 0 && !searching));
    $('sheet-nomatch').classList.toggle('hidden', !(rows.length === 0 && searching));
    $('btn-new-row').disabled = cols.length === 0;
    $('btn-new-row').classList.toggle('hidden', !canEditCurrentTab());

    // <colgroup> drives the widths, which is what makes dragging work
    var table = $('sheet-table');
    var old = table.querySelector('colgroup');
    if (old) old.remove();
    var cg = document.createElement('colgroup');
    var gcol = document.createElement('col');
    gcol.style.width = '54px';
    cg.appendChild(gcol);
    cols.forEach(function (c) {
      var col = document.createElement('col');
      col.style.width = colWidth(c) + 'px';
      cg.appendChild(col);
    });
    table.insertBefore(cg, table.firstChild);

    var hr = el('tr');
    hr.appendChild(el('th', 'sheet-gutter', ''));
    cols.forEach(function (c, i) {
      var th = el('th', null, c.name);
      th.title = c.name;
      var handle = el('span', 'col-resizer', '');
      handle.addEventListener('mousedown', function (ev) { startColumnResize(ev, c, i); });
      handle.addEventListener('dblclick', function (ev) {
        ev.preventDefault();
        delete state.colWidths[c.key];   // double-click resets to the default
        saveColWidths();
        renderSheet();
      });
      th.appendChild(handle);
      hr.appendChild(th);
    });
    head.replaceChildren(hr);

    function buildTr(row) {
      var status = row.data ? String(row.data.status || '').toLowerCase() : '';
      var tint = (status === 'green' || status === 'yellow' || status === 'red') ? ' st-' + status : '';
      var tr = el('tr', 'sheet-row-open' + tint);
      tr.appendChild(el('td', 'sheet-gutter', String((row.position || 0) + 1)));
      cols.forEach(function (c, i) {
        var text = sheetValue(row, c);
        var td = el('td', 'sheet-cell' + (i === 0 ? ' sheet-first' : '') + (text ? '' : ' empty-cell'),
          text || '—');
        td.setAttribute('data-label', c.name);
        if (text) td.title = text;      // full value on hover, since cells clip
        tr.appendChild(td);
      });
      tr.addEventListener('click', function () { openRowModal('edit', row); });
      return tr;
    }

    // Thousands of rows are appended in chunks so the app never freezes.
    var token = ++state.renderToken;
    body.replaceChildren();
    var i = 0;
    (function chunk() {
      if (token !== state.renderToken) return;   // a newer render took over
      var frag = document.createDocumentFragment();
      for (var k = 0; k < 500 && i < rows.length; k++, i++) frag.appendChild(buildTr(rows[i]));
      body.appendChild(frag);
      if (i < rows.length) window.requestAnimationFrame(chunk);
    })();

    var total = state.sheetTotal;
    var label;
    if (state.fullSheet) {
      label = state.sheetQuery
        ? rows.length.toLocaleString() + ' of ' + total.toLocaleString() +
          ' rows match "' + state.sheetQuery + '"'
        : total.toLocaleString() + (total === 1 ? ' row' : ' rows');
      $('btn-sheet-more').classList.add('hidden');
    } else {
      label = total.toLocaleString() + (total === 1 ? ' row' : ' rows');
      if (state.sheetQuery) label += ' matching "' + state.sheetQuery + '"';
      if (state.sheetRows.length < total) label += ' · showing first ' + state.sheetRows.length.toLocaleString();
      $('btn-sheet-more').classList.toggle('hidden', state.sheetRows.length >= total);
      $('btn-sheet-more').textContent = 'Load more rows (' +
        (total - state.sheetRows.length).toLocaleString() + ' left)';
    }
    $('count-label').textContent = label;
  }

  // Drag the right edge of a header cell to resize, exactly like a
  // spreadsheet. Double-clicking the handle restores the default width.
  function startColumnResize(ev, col, index) {
    ev.preventDefault();
    ev.stopPropagation();
    var table = $('sheet-table');
    var colEl = table.querySelectorAll('colgroup col')[index + 1];
    if (!colEl) return;
    var startX = ev.clientX;
    var startW = parseInt(colEl.style.width, 10) || colWidth(col);
    document.body.classList.add('col-resizing');

    // A column can be dragged no narrower than its header text (capped at
    // 20 characters), so the header never gets swallowed.
    var minW = 56;
    var th = table.querySelectorAll('#sheet-head th')[index + 1];
    if (th) {
      var cs = window.getComputedStyle(th);
      var canvas = startColumnResize._c || (startColumnResize._c = document.createElement('canvas'));
      var ctx = canvas.getContext('2d');
      ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      var label = col.name.length > 20 ? col.name.slice(0, 20) : col.name;
      if (cs.textTransform === 'uppercase') label = label.toUpperCase();
      minW = Math.max(40, Math.ceil(ctx.measureText(label).width * 1.04) + 18);
    }

    function onMove(e) {
      var w = Math.max(minW, startW + (e.clientX - startX));
      colEl.style.width = w + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
      state.colWidths[col.key] = parseInt(colEl.style.width, 10);
      saveColWidths();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- sheet row editor ----------

  var rowModal = null; // { mode, id, version }

  function rowFieldId(col) { return 'rowfield-' + col.id; }

  function buildRowFields(row) {
    var wrap = $('row-fields');
    wrap.replaceChildren();
    state.sheetCols.forEach(function (c) {
      var lab = el('label', 'field');
      lab.appendChild(el('span', null, c.name));
      var v = (row && row.data) ? row.data[c.key] : null;
      var input;
      if (c.kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = v == null ? '' : String(v);
      } else if (c.kind === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = (v === true || v === 'true');
        input.style.width = 'auto';
      } else if (c.kind === 'picklist') {
        input = document.createElement('select');
        var blank = el('option', null, '—');
        blank.value = '';
        input.appendChild(blank);
        (c.options || []).forEach(function (o) {
          var opt = el('option', null, o);
          opt.value = o;
          if (String(v) === o) opt.selected = true;
          input.appendChild(opt);
        });
        if (v && (c.options || []).indexOf(String(v)) < 0) {
          var extra = el('option', null, String(v));
          extra.value = String(v);
          extra.selected = true;
          input.appendChild(extra);
        }
      } else if (c.kind === 'autonumber') {
        input = document.createElement('input');
        input.type = 'text';
        input.readOnly = true;
        input.value = v == null ? '(assigned automatically)' : String(v);
      } else {
        input = document.createElement('input');
        input.type = c.kind === 'number' ? 'number' : (c.kind === 'date' ? 'date' : 'text');
        input.value = v == null ? '' : (c.kind === 'date' ? String(v).slice(0, 10) : String(v));
      }
      input.id = rowFieldId(c);
      lab.appendChild(input);
      wrap.appendChild(lab);
    });
  }

  function collectRowData() {
    var data = {};
    state.sheetCols.forEach(function (c) {
      var input = $(rowFieldId(c));
      if (!input) return;
      if (c.kind === 'checkbox') { data[c.key] = !!input.checked; return; }
      if (c.kind === 'autonumber') {
        // never typed by hand: keep what the row has; the database assigns
        // the next number when a new row is inserted
        var kept = rowModal && rowModal.origData ? rowModal.origData[c.key] : null;
        if (kept !== null && kept !== undefined) data[c.key] = kept;
        return;
      }
      var val = input.value;
      if (val === '') { data[c.key] = null; return; }
      data[c.key] = c.kind === 'number' ? Number(val) : val;
    });
    return data;
  }

  function setRowError(msg) {
    var e = $('row-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function openRowModal(mode, row) {
    rowModal = { mode: mode, id: row ? row.id : null, version: row ? row.version : null,
      origData: (row && row.data) ? row.data : {} };
    $('row-modal-title').textContent = mode === 'create' ? 'New row' : 'Edit row';
    $('row-conflict').classList.add('hidden');
    setRowError(null);
    $('btn-row-delete').classList.toggle('hidden', mode !== 'edit');
    $('row-meta').textContent = !row ? ''
      : (row.updated_by
          ? 'Last edited by ' + profileName(row.updated_by) + ' ' + relTime(row.updated_at)
          : 'Imported from Smartsheet') + ' · version ' + row.version;
    buildRowFields(row);
    var editable = canEditCurrentTab();
    $('btn-row-save').classList.toggle('hidden', !editable);
    if (!editable) {
      $('btn-row-delete').classList.add('hidden');
      $('row-fields').querySelectorAll('input, select, textarea').forEach(function (f) {
        f.disabled = true;
      });
      $('row-meta').textContent += ' · view only';
    }
    $('row-backdrop').classList.remove('hidden');
  }

  function closeRowModal() {
    rowModal = null;
    $('row-backdrop').classList.add('hidden');
  }

  async function saveRow(e) {
    e.preventDefault();
    if (!rowModal) return;
    if (!canEditCurrentTab()) { setRowError('You have view-only access on this tab.'); return; }
    var btn = $('btn-row-save');
    btn.disabled = true;
    setRowError(null);
    try {
      var data = collectRowData();
      if (rowModal.mode === 'create') {
        var maxPos = state.sheetRows.reduce(function (m, r) { return Math.max(m, r.position || 0); },
          state.sheetTotal - 1);
        var ins = await sb.from('sheet_rows')
          .insert({ tab_id: state.currentTabId, position: maxPos + 1, data: data })
          .select(SHEET_ROW_SELECT).single();
        if (ins.error) throw ins.error;
        state.sheetRows.unshift(ins.data);
        state.sheetTotal += 1;
        closeRowModal();
        renderSheet();
        toast('Row added', 'ok');
        return;
      }
      var upd = await sb.from('sheet_rows').update({ data: data })
        .eq('id', rowModal.id).eq('version', rowModal.version)
        .select(SHEET_ROW_SELECT);
      if (upd.error) throw upd.error;
      if (upd.data && upd.data.length > 0) {
        var i = state.sheetRows.findIndex(function (r) { return r.id === rowModal.id; });
        if (i >= 0) state.sheetRows[i] = upd.data[0];
        closeRowModal();
        renderSheet();
        toast('Saved', 'ok');
        return;
      }
      // 0 rows updated: someone saved first, or the row is gone
      var cur = await sb.from('sheet_rows').select(SHEET_ROW_SELECT)
        .eq('id', rowModal.id).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) {
        state.sheetRows = state.sheetRows.filter(function (r) { return r.id !== rowModal.id; });
        closeRowModal();
        renderSheet();
        toast('That row was deleted by someone else.', 'warn', 6000);
        return;
      }
      var j = state.sheetRows.findIndex(function (r) { return r.id === cur.data.id; });
      if (j >= 0) state.sheetRows[j] = cur.data;
      rowModal.version = cur.data.version;
      var c = $('row-conflict');
      c.textContent = '⚠ This row was changed by ' + profileName(cur.data.updated_by) + ' (' +
        relTime(cur.data.updated_at) + ') while you were editing. Your edits have NOT been saved. ' +
        'Press Save again to replace their version with yours.';
      c.classList.remove('hidden');
      renderSheet();
    } catch (err) {
      setRowError('Could not save: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteRow() {
    if (!rowModal || rowModal.mode !== 'edit') return;
    if (!window.confirm('Delete this row? This removes it for everyone who can see this tab.')) return;
    try {
      var res = await sb.from('sheet_rows').delete().eq('id', rowModal.id).select('id');
      if (res.error) throw res.error;
      state.sheetRows = state.sheetRows.filter(function (r) { return r.id !== rowModal.id; });
      state.sheetTotal = Math.max(0, state.sheetTotal - 1);
      closeRowModal();
      renderSheet();
      toast('Row deleted', 'ok');
    } catch (err) {
      setRowError('Could not delete: ' + err.message);
    }
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
        if (tabModal.open) { closeTabModal(); return; }
        if (rowModal) { closeRowModal(); return; }
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
    $('btn-new-tab').addEventListener('click', function () { openTabModal('create'); });
    $('btn-tab-settings').addEventListener('click', function () { openTabModal('edit'); });
    $('btn-tab-save').addEventListener('click', saveTab);
    $('tab-kind').addEventListener('change', function () {
      updateTabColsVisibility();
      renderTabCols();
    });
    $('btn-tab-addcol').addEventListener('click', function () {
      tabModal.cols.push({ id: null, key: null, name: '', kind: 'text', options: [] });
      renderTabCols();
      var inputs = $('tab-cols').querySelectorAll('input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $('btn-tab-delete').addEventListener('click', deleteTab);
    $('btn-tab-cancel').addEventListener('click', closeTabModal);
    $('tab-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeTabModal();
    });

    $('btn-new-row').addEventListener('click', function () { openRowModal('create', null); });
    $('row-form').addEventListener('submit', saveRow);
    $('btn-row-cancel').addEventListener('click', closeRowModal);
    $('btn-row-delete').addEventListener('click', deleteRow);
    $('row-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeRowModal();
    });
    $('sheet-search').addEventListener('input', onSheetSearch);
    $('btn-sheet-more').addEventListener('click', function () { loadSheetRows(false); });

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
