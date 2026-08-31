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
    if (col.kind === 'number' || col.kind === 'uniquenumber') return 72;
    if (col.kind === 'checkbox') return 72;
    if (col.kind === 'textarea') return 260;
    if (col.kind === 'picklist') return 140;
    return Math.min(260, Math.max(110, col.name.length * 9 + 30));
  }

  function colWidth(col) {
    var w = state.colWidths[col.key];
    if (typeof w === 'number' && w > 40) return w;   // the user's remembered drag
    if (state.colAutoWidths[col.key]) return state.colAutoWidths[col.key];
    var auto = measureColWidth(col);
    if (auto) { state.colAutoWidths[col.key] = auto; return auto; }
    return defaultColWidth(col);
  }

  // Default width = wide enough for the header text and the loaded values,
  // capped at ~100 characters. Hovering a cell always shows the full text.
  function measureColWidth(col) {
    var canvas = measureColWidth._c || (measureColWidth._c = document.createElement('canvas'));
    var ctx = canvas.getContext('2d');
    var family = window.getComputedStyle(document.body).fontFamily || 'sans-serif';
    ctx.font = '11px ' + family;
    var headerW = ctx.measureText(col.name.toUpperCase()).width * 1.04;
    ctx.font = '12.5px ' + family;
    var capPx = ctx.measureText('n'.repeat(100)).width;
    var w = headerW;
    var rows = state.sheetRows;
    var count = Math.min(rows.length, 300);
    for (var i = 0; i < count; i++) {
      var t = sheetValue(rows[i], col);
      if (!t) continue;
      // multi-line values count by their longest line, and anything past the
      // cap cannot matter
      var line = t.split(/\r\n|\r|\n/).reduce(function (a, b) {
        return b.length > a.length ? b : a;
      }, '');
      var mw = ctx.measureText(line.slice(0, 110)).width;
      if (mw > w) w = mw;
    }
    return Math.ceil(Math.max(56, Math.min(Math.max(w, headerW), capPx))) + 18;
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
    colAutoWidths: {},  // measured default widths for the current sheet
    hiddenCols: new Set(), // column keys hidden by the "Columns" filter
    sortDir: 'desc',    // 'desc' = newest first, 'asc' = oldest first
    flashRowId: null,   // row to flash after a paste/move
    renderedRows: [],   // the rows renderSheet last displayed, in order
    restorePending: false, // restore the saved scroll spot after next render
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
  // Every device pages 200 rows at a time behind the "Load more" button.
  // If someone does page all the way through, search switches to instant
  // on-device filtering automatically.
  async function loadSheetRows(reset) {
    var tab = currentTab();
    if (!tab || tab.kind !== 'sheet') return;
    var q = $('sheet-search').value.trim();
    if (reset) {
      state.sheetRows = [];
      state.sheetQuery = q;
      state.fullSheet = false;
      state.colAutoWidths = {};   // default widths re-derive from the first page
      var c = await sb.rpc('count_sheet_rows', { p_tab: tab.id, p_q: q });
      state.sheetTotal = c.error ? 0 : Number(c.data);
    }
    var res = await sb.rpc('search_sheet_rows', {
      p_tab: tab.id, p_q: q, p_limit: SHEET_PAGE, p_offset: state.sheetRows.length,
    });
    if (res.error) {
      toast('Could not load rows: ' + res.error.message, 'error', 6000);
      return;
    }
    state.sheetRows = state.sheetRows.concat(res.data || []);
    state.fullSheet = q === '' && state.sheetRows.length >= state.sheetTotal;
    // In newest-at-bottom mode older pages appear ABOVE the current view;
    // keep the reader anchored on the rows they were looking at.
    var wrapEl = document.querySelector('#sheet-view .table-wrap');
    var preH = (!reset && state.sortDir === 'asc' && wrapEl) ? wrapEl.scrollHeight : null;
    renderSheet();
    if (preH !== null) {
      window.setTimeout(function () {
        wrapEl.scrollTop += (wrapEl.scrollHeight - preH);
      }, 120);
    }
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
      if (sheetValue(row, c).toLowerCase().indexOf(q) >= 0) return true;
      var l = cellLink(row, c);
      return !!(l && l.toLowerCase().indexOf(q) >= 0);
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
        state.hiddenCols = loadHiddenCols();
        state.sortDir = loadSortDir();
        $('sheet-sortdir').value = state.sortDir;
        state.colAutoWidths = {};
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
      if (state.restorePending) {
        state.restorePending = false;
        restoreScrollState();
      }
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
      asgIds.length === 0 ? 'Unassigned' : (asgNames.join(', ') || '—')));
    tr.appendChild(tdAsg);

    var tdCr = el('td', 'col-created');
    tdCr.appendChild(el('div', 'created-when', formatDue(String(t.created_at).slice(0, 10))));
    tdCr.appendChild(el('div', 'created-who muted small', personName(t.creator)));
    tdCr.title = 'Created by ' + personName(t.creator) + ' on ' + fullTime(t.created_at);
    tr.appendChild(tdCr);

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
    var everyone = el('option', null, 'Unassigned');
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
      summary: function (set) { return summarizePeople(set, 'No one'); },
      empty: 'No team members found.',
      // Nobody ticked = unassigned. The panel shows a "No one" row that is
      // on by default; ticking a person replaces it.
      everyoneRow: 'No one (unassigned)',
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
      if (m.attachRename === f.name) {
        list.appendChild(buildAttachRenameRow(f, m.id, function () {
          m.attachRename = null;
          loadAttachments();
        }, function () {
          m.attachRename = null;
          renderAttachments();
        }));
        return;
      }
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
      var ren = el('button', 'icon-btn', '✎');
      ren.type = 'button';
      ren.title = 'Rename attachment';
      ren.addEventListener('click', function () {
        m.attachRename = f.name;
        renderAttachments();
      });
      row.appendChild(ren);
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

  // Renaming keeps the hidden upload-timestamp prefix (ordering and
  // uniqueness) and the old extension if the new name dropped it.
  async function renameAttachment(folderId, oldName, newDisplay) {
    var base = String(newDisplay || '').trim();
    if (!base) {
      toast('Enter a file name.', 'warn', 4000);
      return false;
    }
    var oldExt = (oldName.match(/(\.[A-Za-z0-9]{1,8})$/) || [])[1] || '';
    if (oldExt && base.toLowerCase().slice(-oldExt.length) !== oldExt.toLowerCase()) {
      base += oldExt;
    }
    var safe = base.replace(/[^\w.\-()]+/g, '_').slice(0, 140);
    var pre = oldName.match(/^(\d+_)/);
    var newName = (pre ? pre[1] : '') + safe;
    if (newName === oldName) return true;
    var res = await sb.storage.from('attachments')
      .move(folderId + '/' + oldName, folderId + '/' + newName);
    if (res.error) {
      toast('Could not rename: ' + res.error.message, 'error', 6000);
      return false;
    }
    toast('Attachment renamed', 'ok');
    return true;
  }

  function buildAttachRenameRow(f, folderId, onDone, onCancel) {
    var row = el('div', 'attach-row');
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 140;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = displayFileName(f.name);
    var save = el('button', 'btn primary btn-small', 'Rename');
    save.type = 'button';
    save.addEventListener('click', function () {
      save.disabled = true;
      renameAttachment(folderId, f.name, input.value).then(function (ok) {
        if (ok) onDone(); else save.disabled = false;
      });
    });
    var cancel = el('button', 'btn ghost btn-small', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save.click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    });
    row.appendChild(input);
    row.appendChild(save);
    row.appendChild(cancel);
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return row;
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

  // A change to one sheet row lands directly in the loaded rows — refetching
  // a whole 7,000-row sheet for every save would make the app feel stuck.
  function applySheetRowChange(p) {
    var tab = currentTab();
    if (!tab || tab.kind !== 'sheet') return;   // sheet events never affect task views
    var rec = (p.new && p.new.id) ? p.new : null;
    var oldRec = (p.old && p.old.id) ? p.old : null;
    if (p.eventType === 'DELETE') {
      if (!oldRec) return;
      var j = state.sheetRows.findIndex(function (r) { return r.id === oldRec.id; });
      if (j >= 0) {
        state.sheetRows.splice(j, 1);
        state.sheetTotal = Math.max(0, state.sheetTotal - 1);
        renderSheet();
      }
      return;
    }
    if (!rec || rec.tab_id !== tab.id) return;  // a different sheet tab
    var i = state.sheetRows.findIndex(function (r) { return r.id === rec.id; });
    if (i >= 0) {
      state.sheetRows[i] = Object.assign({}, state.sheetRows[i], rec);
    } else if (p.eventType === 'INSERT') {
      state.sheetRows.push(rec);
      sortLoadedRows();
      state.sheetTotal += 1;
    } else {
      return;   // an update to a row this phone hasn't paged in yet
    }
    renderSheet();
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
        applySheetRowChange(payload);
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
    state.restorePending = true;     // reopen where the app was closed
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
    saveScrollState();               // remember the spot on the tab we leave
    state.restorePending = true;     // and restore the one we arrive at
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
    ['uniquenumber', 'Number (unique in its column)'],
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
    var cols = visibleSheetCols();
    var rows = state.sortDir === 'asc' ? state.sheetRows.slice().reverse() : state.sheetRows;
    if (state.fullSheet && state.sheetQuery) {
      var q = state.sheetQuery.toLowerCase();
      rows = rows.filter(function (r) { return rowMatchesQuery(r, q); });
    }
    state.renderedRows = rows;
    var head = $('sheet-head');
    var body = $('sheet-body');

    var searching = state.sheetQuery !== '';
    $('sheet-nocols').textContent = state.sheetCols.length === 0
      ? 'This sheet has no columns yet.'
      : 'All columns are hidden — tick some under “Columns”.';
    updateColVisButton();
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
    gcol.style.width = '64px';
    cg.appendChild(gcol);
    cols.forEach(function (c) {
      var col = document.createElement('col');
      col.style.width = colWidth(c) + 'px';
      cg.appendChild(col);
    });
    table.insertBefore(cg, table.firstChild);

    // Fixed layout plus an explicit pixel width: the table tracks the column
    // sum exactly, so shrinking a column genuinely shrinks it on screen
    // (with width:max-content Chrome quietly hands freed space back).
    if (!isPhone()) {
      var totalW = 64;
      cols.forEach(function (c) { totalW += colWidth(c); });
      table.style.width = totalW + 'px';
    } else {
      table.style.width = '';
    }

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

    function buildTr(row, index) {
      var status = row.data ? String(row.data.status || '').toLowerCase() : '';
      var tint = (status === 'green' || status === 'yellow' || status === 'red') ? ' st-' + status : '';
      if (rowClipboard && rowClipboard.rowId === row.id &&
          rowClipboard.tabId === state.currentTabId) tint += ' row-clipboard';
      if (state.flashRowId === row.id) tint += ' row-flash';
      var tr = el('tr', 'sheet-row-open' + tint);
      var gutter = el('td', 'sheet-gutter');
      var openBtn = el('button', 'row-open-btn', '\u270E');
      openBtn.type = 'button';
      openBtn.title = 'Open this row';
      openBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openRowModal('edit', row);
      });
      gutter.appendChild(openBtn);
      gutter.appendChild(el('span', null, String(index + 1)));
      gutter.title = 'Drag to move this row · right-click to insert rows';
      gutter.addEventListener('contextmenu', function (ev) { openRowMenu(ev, row); });
      gutter.addEventListener('mousedown', function (ev) { startRowDrag(ev, row); });
      tr.appendChild(gutter);
      cols.forEach(function (c, i) {
        var text = sheetValue(row, c);
        var link = cellLink(row, c);
        var td = el('td', 'sheet-cell' + (i === 0 ? ' sheet-first' : '') +
          (text || link ? '' : ' empty-cell'));
        if (link) {
          var a = document.createElement('a');
          a.href = link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = text || link;
          // opening the link must not also open the row editor
          a.addEventListener('click', function (ev) { ev.stopPropagation(); });
          td.appendChild(a);
          td.title = (text ? text + '\n' : '') + link;
        } else {
          td.textContent = text || '—';
          if (text) td.title = text;    // full value on hover, since cells clip
        }
        td.setAttribute('data-label', c.name);
        td.addEventListener('contextmenu', function (ev) { openCellMenu(ev, row, c, index, i); });
        td.addEventListener('mousedown', function (ev) { cellMouseDown(ev, index, i); });
        td.addEventListener('mouseover', function () { cellMouseOver(index, i); });
        td.addEventListener('dblclick', function (ev) {
          ev.preventDefault();
          if (!isPhone()) startInlineEdit(td, row, c);
        });
        tr.appendChild(td);
      });
      // Phones open the card editor on tap; on desktop the pencil in the
      // gutter opens it, leaving clicks free for in-place editing.
      tr.addEventListener('click', function () { if (isPhone()) openRowModal('edit', row); });
      return tr;
    }

    // Thousands of rows are appended in chunks so the app never freezes.
    var token = ++state.renderToken;
    body.replaceChildren();
    var i = 0;
    (function chunk() {
      if (token !== state.renderToken) return;   // a newer render took over
      var frag = document.createDocumentFragment();
      for (var k = 0; k < 500 && i < rows.length; k++, i++) frag.appendChild(buildTr(rows[i], i));
      body.appendChild(frag);
      if (i < rows.length) window.requestAnimationFrame(chunk);
      else applyCellSelection();
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
    var startTableW = parseInt(table.style.width, 10) || table.getBoundingClientRect().width;
    document.body.classList.add('col-resizing');

    // A column can be dragged no narrower than its header text (capped at
    // 20 characters), so the header never gets swallowed.
    // Shrink as far as you like - header and cells clip with an ellipsis,
    // and hovering a cell still shows its full text.
    var minW = 36;

    function onMove(e) {
      var w = Math.max(minW, startW + (e.clientX - startX));
      colEl.style.width = w + 'px';
      table.style.width = (startTableW + (w - startW)) + 'px';
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

  // ---------- column display filter ----------

  function sortDirKey() { return 'tenways.sortdir.' + state.currentTabId; }

  function loadSortDir() {
    try { return window.localStorage.getItem(sortDirKey()) === 'asc' ? 'asc' : 'desc'; }
    catch (e) { return 'desc'; }
  }

  function sortLoadedRows() {
    state.sheetRows.sort(function (a, b) {
      return (Number(b.position) || 0) - (Number(a.position) || 0);
    });
  }

  // In "newest at bottom" mode the loaded rows are simply drawn bottom-up;
  // visual up/down therefore flips relative to the master (newest-first) list.
  function visualStep(where) {
    var up = state.sortDir === 'asc' ? 1 : -1;   // master-index delta for "above"
    return where === 'above' ? up : -up;
  }

  function colVisKey() { return 'tenways.colvis.' + state.currentTabId; }

  function loadHiddenCols() {
    try { return new Set(JSON.parse(window.localStorage.getItem(colVisKey()) || '[]')); }
    catch (e) { return new Set(); }
  }

  function saveHiddenCols() {
    try { window.localStorage.setItem(colVisKey(), JSON.stringify(Array.from(state.hiddenCols))); }
    catch (e) { /* private mode */ }
  }

  function visibleSheetCols() {
    return state.sheetCols.filter(function (c) { return !state.hiddenCols.has(c.key); });
  }

  function updateColVisButton() {
    var hidden = state.sheetCols.filter(function (c) { return state.hiddenCols.has(c.key); }).length;
    $('btn-colvis').textContent = hidden ? 'Columns · ' + hidden + ' hidden' : 'Columns';
  }

  function closeColVisPanel() {
    var p = $('colvis-panel');
    if (p.classList.contains('hidden')) return false;
    p.classList.add('hidden');
    return true;
  }

  function toggleColVisPanel() {
    var p = $('colvis-panel');
    if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
    buildColVisPanel();
    p.classList.remove('hidden');
  }

  function buildColVisPanel() {
    var p = $('colvis-panel');
    p.replaceChildren();
    function onTick() {
      saveHiddenCols();
      buildColVisPanel();
      updateColVisButton();
      renderSheet();
    }
    var all = el('label', 'msel-row msel-everyone');
    var allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.checked = state.hiddenCols.size === 0;
    allCb.addEventListener('change', function () {
      state.hiddenCols.clear();
      onTick();
    });
    all.appendChild(allCb);
    all.appendChild(el('span', null, 'Show all columns'));
    p.appendChild(all);
    state.sheetCols.forEach(function (c) {
      var row = el('label', 'msel-row');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.hiddenCols.has(c.key);
      cb.addEventListener('change', function () {
        if (cb.checked) state.hiddenCols.delete(c.key); else state.hiddenCols.add(c.key);
        onTick();
      });
      row.appendChild(cb);
      row.appendChild(el('span', null, c.name));
      p.appendChild(row);
    });
  }

  // ---------- sheet row attachments ----------
  // Same bucket and path scheme as record attachments (<row_id>/<file>);
  // the storage policies grant read to tab viewers, upload to tab editors.

  async function rowLoadAttachments() {
    var m = rowModal;
    if (!m || m.mode !== 'edit' || !m.id) return;
    var res = await sb.storage.from('attachments').list(m.id, {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (res.error) {
      console.log('[app] row attachments list failed: ' + res.error.message);
      return;
    }
    if (!rowModal || rowModal.id !== m.id) return; // the modal moved on meanwhile
    rowModal.attachments = res.data || [];
    renderRowAttachments();
  }

  function renderRowAttachments() {
    var list = $('row-attach-list');
    list.replaceChildren();
    var m = rowModal;
    if (!m) return;
    var canEdit = canEditCurrentTab();
    var files = m.attachments || [];
    files.forEach(function (f) {
      if (canEdit && m.attachRename === f.name) {
        list.appendChild(buildAttachRenameRow(f, m.id, function () {
          m.attachRename = null;
          rowLoadAttachments();
        }, function () {
          m.attachRename = null;
          renderRowAttachments();
        }));
        return;
      }
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
      if (canEdit) {
        var ren = el('button', 'icon-btn', '✎');
        ren.type = 'button';
        ren.title = 'Rename attachment';
        ren.addEventListener('click', function () {
          m.attachRename = f.name;
          renderRowAttachments();
        });
        row.appendChild(ren);
        var del = el('button', 'icon-btn danger', '✕');
        del.type = 'button';
        del.title = 'Delete attachment';
        del.addEventListener('click', function () { rowDeleteAttachment(m.id, f.name); });
        row.appendChild(del);
      }
      list.appendChild(row);
    });
    if (files.length === 0 && m.mode === 'edit') {
      list.appendChild(el('div', 'muted small', 'No attachments yet.'));
    }
  }

  async function rowUploadAttachments(files) {
    var m = rowModal;
    if (!m || m.mode !== 'edit' || !m.id) return;
    var status = el('div', 'attach-uploading', 'Uploading…');
    $('row-attach-list').prepend(status);
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
    await rowLoadAttachments();
    if (failed.length) {
      toast('Could not upload: ' + failed.join('; '), 'error', 8000);
    } else {
      toast(files.length === 1 ? 'File attached' : files.length + ' files attached', 'ok');
    }
  }

  async function rowDeleteAttachment(rowId, name) {
    if (!window.confirm('Delete attachment "' + displayFileName(name) + '"?')) return;
    var res = await sb.storage.from('attachments').remove([rowId + '/' + name]);
    if (res.error) {
      toast('Could not delete: ' + res.error.message, 'error', 6000);
      return;
    }
    toast('Attachment deleted', 'ok');
    rowLoadAttachments();
  }

  // ---------- Excel-style cell selection + copy / single-cell paste ----------

  var cellSel = null;    // { a: {r, c}, b: {r, c} } over renderedRows / visible cols
  var cellDragging = false;
  var flashSelection = false;

  function clearCellSelection() {
    cellSel = null;
    document.querySelectorAll('#sheet-body td.cell-selected').forEach(function (td) {
      td.classList.remove('cell-selected');
    });
    positionFillHandle();
  }

  function positionFillHandle() {
    var h = $('fill-handle');
    if (!cellSel || isPhone() || !canEditCurrentTab()) { h.classList.add('hidden'); return; }
    var body = $('sheet-body');
    var r2 = Math.max(cellSel.a.r, cellSel.b.r);
    var c2 = Math.max(cellSel.a.c, cellSel.b.c);
    var tr = body.children[r2];
    var td = tr && tr.children[c2 + 1];
    var wrapEl = document.querySelector('#sheet-view .table-wrap');
    if (!td || !wrapEl) { h.classList.add('hidden'); return; }
    var rect = td.getBoundingClientRect();
    var wrap = wrapEl.getBoundingClientRect();
    if (rect.bottom < wrap.top + 30 || rect.top > wrap.bottom ||
        rect.right < wrap.left || rect.left > wrap.right) {
      h.classList.add('hidden');
      return;
    }
    h.style.left = (rect.right - 5) + 'px';
    h.style.top = (rect.bottom - 5) + 'px';
    h.classList.remove('hidden');
  }

  function applyCellSelection() {
    document.querySelectorAll('#sheet-body td.cell-selected').forEach(function (td) {
      td.classList.remove('cell-selected');
    });
    if (!cellSel) return;
    var rows = state.renderedRows || [];
    var cols = visibleSheetCols();
    var r1 = Math.min(cellSel.a.r, cellSel.b.r), r2 = Math.max(cellSel.a.r, cellSel.b.r);
    var c1 = Math.min(cellSel.a.c, cellSel.b.c), c2 = Math.max(cellSel.a.c, cellSel.b.c);
    if (r1 >= rows.length || c1 >= cols.length) { cellSel = null; return; }
    var body = $('sheet-body');
    for (var r = r1; r <= r2 && r < rows.length; r++) {
      var tr = body.children[r];
      if (!tr) continue;
      for (var c = c1; c <= c2 && c < cols.length; c++) {
        var td = tr.children[c + 1];   // +1 skips the row-number gutter
        if (td) td.classList.add('cell-selected');
      }
    }
    if (flashSelection) {
      flashSelection = false;
      document.querySelectorAll('#sheet-body td.cell-selected').forEach(function (td) {
        td.classList.add('cell-flash');
      });
      window.setTimeout(function () {
        document.querySelectorAll('#sheet-body td.cell-flash').forEach(function (td) {
          td.classList.remove('cell-flash');
        });
      }, 1400);
    }
    positionFillHandle();
  }

  // ---------- the fill handle: drag to copy / continue a series ----------

  var fillDrag = null;

  function cellIndexOfTd(td) {
    var tr = td.parentElement;
    var body = $('sheet-body');
    var r = Array.prototype.indexOf.call(body.children, tr);
    var c = Array.prototype.indexOf.call(tr.children, td) - 1;
    return (r >= 0 && c >= 0) ? { r: r, c: c } : null;
  }

  function clearFillPreview() {
    document.querySelectorAll('#sheet-body td.cell-fill-preview').forEach(function (td) {
      td.classList.remove('cell-fill-preview');
    });
  }

  function startFillDrag(ev) {
    if (!cellSel || isPhone() || !canEditCurrentTab()) return;
    ev.preventDefault();
    ev.stopPropagation();
    fillDrag = {
      r1: Math.min(cellSel.a.r, cellSel.b.r), r2: Math.max(cellSel.a.r, cellSel.b.r),
      c1: Math.min(cellSel.a.c, cellSel.b.c), c2: Math.max(cellSel.a.c, cellSel.b.c),
      target: null,
    };
    document.addEventListener('mousemove', onFillDragMove);
    document.addEventListener('mouseup', onFillDragUp);
  }

  function onFillDragMove(e) {
    if (!fillDrag) return;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var td = under && under.closest ? under.closest('#sheet-body td') : null;
    clearFillPreview();
    fillDrag.target = null;
    if (!td) return;
    var idx = cellIndexOfTd(td);
    if (!idx) return;
    var d = fillDrag;
    var beyondV = idx.r > d.r2 ? idx.r - d.r2 : (idx.r < d.r1 ? idx.r - d.r1 : 0);
    var beyondH = idx.c > d.c2 ? idx.c - d.c2 : (idx.c < d.c1 ? idx.c - d.c1 : 0);
    var t = null;
    if (beyondV !== 0 && Math.abs(beyondV) >= Math.abs(beyondH)) {
      t = beyondV > 0
        ? { r1: d.r2 + 1, r2: idx.r, c1: d.c1, c2: d.c2, axis: 'v', dir: 1 }
        : { r1: idx.r, r2: d.r1 - 1, c1: d.c1, c2: d.c2, axis: 'v', dir: -1 };
    } else if (beyondH !== 0) {
      t = beyondH > 0
        ? { r1: d.r1, r2: d.r2, c1: d.c2 + 1, c2: idx.c, axis: 'h', dir: 1 }
        : { r1: d.r1, r2: d.r2, c1: idx.c, c2: d.c1 - 1, axis: 'h', dir: -1 };
    }
    fillDrag.target = t;
    if (!t) return;
    var body = $('sheet-body');
    for (var r = t.r1; r <= t.r2; r++) {
      var tr = body.children[r];
      if (!tr) continue;
      for (var c = t.c1; c <= t.c2; c++) {
        var cell = tr.children[c + 1];
        if (cell) cell.classList.add('cell-fill-preview');
      }
    }
  }

  // Filling continues a series from a single source cell (numbers +1 per
  // step, dates +1 day, "Item 3" becomes "Item 4"); ranges repeat as-is.
  function fillValueFor(srcRow, col, step) {
    var v = srcRow.data ? srcRow.data[col.key] : null;
    if (v === undefined) v = null;
    if (step === 0 || v === null || v === '') return v;
    if (col.kind === 'number' || col.kind === 'uniquenumber') {
      var num = Number(v);
      return isFinite(num) ? num + step : v;
    }
    if (col.kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      var dt = new Date(v.slice(0, 10) + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + step);
      return dt.toISOString().slice(0, 10);
    }
    if (typeof v === 'string') {
      var t = v.trim();
      if (/^-?\d+$/.test(t)) return String(Number(t) + step);
      var m = v.match(/^(.*?)(\d+)\s*$/);
      if (m) return m[1] + (Number(m[2]) + step);
    }
    return v;
  }

  async function onFillDragUp() {
    document.removeEventListener('mousemove', onFillDragMove);
    document.removeEventListener('mouseup', onFillDragUp);
    clearFillPreview();
    var d = fillDrag;
    fillDrag = null;
    if (!d || !d.target) return;
    var t = d.target;
    var rows = state.renderedRows || [];
    var cols = visibleSheetCols();
    var srcRows = d.r2 - d.r1 + 1;
    var srcCols = d.c2 - d.c1 + 1;
    var series = srcRows === 1 && srcCols === 1;
    var changes = new Map();
    for (var r = t.r1; r <= t.r2 && r < rows.length; r++) {
      if (r < 0) continue;
      for (var c = t.c1; c <= t.c2 && c < cols.length; c++) {
        if (c < 0) continue;
        var col = cols[c];
        if (col.kind === 'autonumber') continue;
        var value;
        if (series) {
          var step = t.axis === 'v'
            ? (t.dir > 0 ? r - d.r2 : r - d.r1)
            : (t.dir > 0 ? c - d.c2 : c - d.c1);
          value = fillValueFor(rows[d.r1], col, step);
        } else if (t.axis === 'v') {
          var srcR = d.r1 + (((r - d.r1) % srcRows) + srcRows) % srcRows;
          value = rows[srcR] && rows[srcR].data ? rows[srcR].data[col.key] : null;
        } else {
          var srcC = d.c1 + (((c - d.c1) % srcCols) + srcCols) % srcCols;
          var srcCol = cols[srcC];
          value = rows[r] && rows[r].data ? rows[r].data[srcCol.key] : null;
        }
        var e2 = changes.get(r) || { row: rows[r], patch: {} };
        e2.patch[col.key] = value === undefined ? null : value;
        changes.set(r, e2);
      }
    }
    if (changes.size === 0) return;
    var ok = await applyCellChanges(Array.from(changes.values()));
    if (ok) {
      cellSel = {
        a: { r: Math.min(d.r1, t.r1), c: Math.min(d.c1, t.c1) },
        b: { r: Math.max(d.r2, t.r2), c: Math.max(d.c2, t.c2) },
      };
      flashSelection = true;
      applyCellSelection();
    }
  }

  function cellMouseDown(ev, rIdx, cIdx) {
    if (isPhone() || ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest('a')) return;   // links open on click
    // clicking away while editing must commit the editor first (blur)
    if (!document.querySelector('.cell-editor')) ev.preventDefault();
    if (ev.shiftKey && cellSel) {
      cellSel.b = { r: rIdx, c: cIdx };
    } else {
      cellSel = { a: { r: rIdx, c: cIdx }, b: { r: rIdx, c: cIdx } };
      cellDragging = true;
    }
    applyCellSelection();
  }

  function cellMouseOver(rIdx, cIdx) {
    if (!cellDragging || !cellSel) return;
    if (cellSel.b.r === rIdx && cellSel.b.c === cIdx) return;
    cellSel.b = { r: rIdx, c: cIdx };
    applyCellSelection();
  }

  function selectionIsSingle() {
    return !!cellSel && cellSel.a.r === cellSel.b.r && cellSel.a.c === cellSel.b.c;
  }

  function selectionTSV() {
    if (!cellSel) return null;
    var rows = state.renderedRows || [];
    var cols = visibleSheetCols();
    var r1 = Math.min(cellSel.a.r, cellSel.b.r), r2 = Math.max(cellSel.a.r, cellSel.b.r);
    var c1 = Math.min(cellSel.a.c, cellSel.b.c), c2 = Math.max(cellSel.a.c, cellSel.b.c);
    var lines = [];
    for (var r = r1; r <= r2 && r < rows.length; r++) {
      var parts = [];
      for (var c = c1; c <= c2 && c < cols.length; c++) {
        parts.push(sheetValue(rows[r], cols[c]));
      }
      lines.push(parts.join('\t'));
    }
    return lines.join('\n');
  }

  // Converts pasted text to a column's kind. { ok:false } = does not fit.
  function convertForKind(col, text) {
    var v = String(text == null ? '' : text);
    if (col.kind === 'number' || col.kind === 'uniquenumber') {
      var t0 = v.trim();
      if (t0 === '') return { ok: true, value: null };
      var num = Number(t0.replace(/,/g, ''));
      return isFinite(num) ? { ok: true, value: num } : { ok: false };
    }
    if (col.kind === 'date') {
      var t = v.trim();
      var dm = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})$/);
      if (dm) {
        var yy = dm[3].length === 2 ? '20' + dm[3] : dm[3];
        t = yy + '-' + String(dm[2]).padStart(2, '0') + '-' + String(dm[1]).padStart(2, '0');
      }
      if (t === '') return { ok: true, value: null };
      if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return { ok: false };
      return { ok: true, value: t.slice(0, 10) };
    }
    if (col.kind === 'checkbox') return { ok: true, value: /^(true|yes|1|y)$/i.test(v.trim()) };
    if (col.kind === 'textarea') {
      var s = v.replace(/\t/g, ' ');
      return { ok: true, value: s === '' ? null : s };
    }
    var s2 = v.replace(/[\t\n]+/g, ' ').trim();
    return { ok: true, value: s2 === '' ? null : s2 };
  }

  // One optimistic-lock update per touched row; other keys stay untouched.
  async function applyCellChanges(changes) {
    var blocked = 0;
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      var cur = state.sheetRows.find(function (r) { return r.id === ch.row.id; }) || ch.row;
      var data = Object.assign({}, cur.data || {});
      Object.keys(ch.patch).forEach(function (k) { data[k] = ch.patch[k]; });
      var upd = await sb.from('sheet_rows').update({ data: data })
        .eq('id', cur.id).eq('version', cur.version).select(SHEET_ROW_SELECT);
      if (upd.error) { toast('Row not saved: ' + upd.error.message, 'error', 5500); continue; }
      if (!upd.data || upd.data.length === 0) { blocked++; continue; }
      var j = state.sheetRows.findIndex(function (r) { return r.id === cur.id; });
      if (j >= 0) state.sheetRows[j] = upd.data[0];
    }
    if (blocked > 0) {
      toast(blocked + ' row(s) were just changed by someone else — reloading.', 'warn', 5000);
      await loadSheetRows(true);
      return false;
    }
    renderSheet();
    return true;
  }

  // Paste: one value fills the whole selection; a block pastes from the
  // selection's top-left corner, Excel-style.
  async function pasteIntoSelectedCell(text) {
    if (!cellSel || !canEditCurrentTab()) return;
    var rows = state.renderedRows || [];
    var cols = visibleSheetCols();
    var raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (raw.slice(-1) === '\n') raw = raw.slice(0, -1);
    var grid = raw.split('\n').map(function (l) { return l.split('\t'); });
    var single = grid.length === 1 && grid[0].length === 1;
    var skipped = 0;
    var changes = new Map();
    function put(rIdx, cIdx, cellText) {
      if (rIdx < 0 || cIdx < 0 || rIdx >= rows.length || cIdx >= cols.length) return;
      var col = cols[cIdx];
      if (col.kind === 'autonumber') { skipped++; return; }
      var conv = convertForKind(col, cellText);
      if (!conv.ok) { skipped++; return; }
      var e = changes.get(rIdx) || { row: rows[rIdx], patch: {} };
      e.patch[col.key] = conv.value;
      changes.set(rIdx, e);
    }
    var r1 = Math.min(cellSel.a.r, cellSel.b.r), r2 = Math.max(cellSel.a.r, cellSel.b.r);
    var c1 = Math.min(cellSel.a.c, cellSel.b.c), c2 = Math.max(cellSel.a.c, cellSel.b.c);
    var rect;
    if (single) {
      for (var r = r1; r <= r2; r++) { for (var c = c1; c <= c2; c++) put(r, c, grid[0][0]); }
      rect = { r1: r1, c1: c1, r2: r2, c2: c2 };
    } else {
      var maxW = 0;
      grid.forEach(function (line, dr) {
        if (line.length > maxW) maxW = line.length;
        line.forEach(function (cellText, dc) { put(r1 + dr, c1 + dc, cellText); });
      });
      rect = { r1: r1, c1: c1,
        r2: Math.min(r1 + grid.length - 1, rows.length - 1),
        c2: Math.min(c1 + maxW - 1, cols.length - 1) };
    }
    if (changes.size === 0) {
      if (skipped) toast('Nothing fitted those columns.', 'warn', 4000);
      return;
    }
    var ok = await applyCellChanges(Array.from(changes.values()));
    if (ok) {
      cellSel = { a: { r: rect.r1, c: rect.c1 }, b: { r: rect.r2, c: rect.c2 } };
      flashSelection = true;
      applyCellSelection();
    }
    if (skipped) toast(skipped + ' cell(s) did not fit their column type.', 'warn', 4500);
  }

  // ---------- empty rows (right-click the row number) ----------

  function openRowMenu(ev, row) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!canEditCurrentTab()) return;
    var m = $('cell-menu');
    m.replaceChildren();
    m.appendChild(menuItem('＋ Add row above', function () { insertEmptyRowNear(row, 'above'); }));
    m.appendChild(menuItem('＋ Add row below', function () { insertEmptyRowNear(row, 'below'); }));
    m.appendChild(menuItem('＋ Add several rows…', function () { openMultiRowModal(row); }));
    m.appendChild(menuItem('✂ Cut row', function () {
      rowClipboard = { mode: 'cut', tabId: state.currentTabId, rowId: row.id };
      renderSheet();   // shows the dashed clipboard highlight
      toast('Row cut — right-click another row number and pick where to paste it.', 'ok', 4500);
    }));
    m.appendChild(menuItem('⧉ Copy row', function () {
      rowClipboard = { mode: 'copy', tabId: state.currentTabId, rowId: row.id,
        data: Object.assign({}, row.data || {}) };
      renderSheet();   // shows the dashed clipboard highlight
      toast('Row copied — right-click a row number and pick where to paste it.', 'ok', 4500);
    }));
    if (rowClipboard && rowClipboard.tabId === state.currentTabId) {
      var verb = rowClipboard.mode === 'cut' ? 'moved' : 'copied';
      m.appendChild(menuItem('Paste ' + verb + ' row above', function () { pasteRowNear(row, 'above'); }));
      m.appendChild(menuItem('Paste ' + verb + ' row below', function () { pasteRowNear(row, 'below'); }));
    }
    m.appendChild(menuItem('✕ Delete this row…', function () { deleteRowDirect(row); }, 'danger-text'));
    m.classList.remove('hidden');
    m.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - m.offsetHeight - 8)) + 'px';
  }

  // Rows are ordered by a numeric position (newest first); inserting between
  // two rows takes the midpoint, so nothing else has to move.
  async function insertEmptyRowNear(row, where) {
    if (state.sheetQuery) {
      toast('Clear the search first — a new empty row would be hidden by it.', 'warn', 5000);
      return;
    }
    var pos = insertPosNear(row, where);
    if (pos === null) return;
    var ins = await sb.from('sheet_rows')
      .insert({ tab_id: state.currentTabId, position: pos, data: {} })
      .select(SHEET_ROW_SELECT).single();
    if (ins.error) {
      toast('Could not add a row: ' + ins.error.message, 'error', 6000);
      return;
    }
    state.sheetRows.push(ins.data);
    sortLoadedRows();
    state.sheetTotal += 1;
    renderSheet();
    toast('Empty row added — double-click its cells to fill it in', 'ok', 4000);
  }

  var rowClipboard = null;  // { mode: 'cut'|'copy', tabId, rowId?, data? }

  // "Above"/"below" are VISUAL; with the sort direction switchable, the
  // numeric direction flips with it. Midpoints between neighbours work
  // either way; only the edges need the direction sign.
  function neighborPosition(row, where) {
    var list = state.sheetRows;
    var i = list.findIndex(function (r) { return r.id === row.id; });
    if (i < 0) return undefined;
    var j = i + visualStep(where);
    return (j >= 0 && j < list.length) ? Number(list[j].position) : null;
  }

  function insertPosNear(row, where) {
    var list = state.sheetRows;
    var i = list.findIndex(function (r) { return r.id === row.id; });
    if (i < 0) return null;
    var np = neighborPosition(row, where);
    var p = Number(row.position);
    if (np !== null) return (p + np) / 2;
    // ran off an edge of the loaded list: which end of the master?
    return (i + visualStep(where) < 0)
      ? p + 1                                                    // beyond the newest row
      : p - (list.length < state.sheetTotal ? 0.5 : 1);          // beyond the oldest loaded
  }

  async function pasteRowNear(target, where) {
    var clip = rowClipboard;
    if (!clip || clip.tabId !== state.currentTabId) return;
    var pos = insertPosNear(target, where);
    if (pos === null) return;
    if (clip.mode === 'cut') {
      if (clip.rowId === target.id) { rowClipboard = null; return; }
      var cur = state.sheetRows.find(function (r) { return r.id === clip.rowId; });
      if (!cur) { toast('That row is no longer loaded.', 'warn', 4000); rowClipboard = null; return; }
      var upd = await sb.from('sheet_rows').update({ position: pos })
        .eq('id', cur.id).eq('version', cur.version).select(SHEET_ROW_SELECT);
      if (upd.error) { toast('Could not move the row: ' + upd.error.message, 'error', 6000); return; }
      if (!upd.data || upd.data.length === 0) {
        toast('This row was just changed by someone else — reloading.', 'warn', 5000);
        rowClipboard = null;
        await loadSheetRows(true);
        return;
      }
      var i = state.sheetRows.findIndex(function (r) { return r.id === cur.id; });
      if (i >= 0) state.sheetRows[i] = upd.data[0];
      rowClipboard = null;
      state.flashRowId = cur.id;
      window.setTimeout(function () { state.flashRowId = null; }, 2000);
      toast('Row moved', 'ok');
    } else {
      var data = Object.assign({}, clip.data);
      // the duplicate gets its own auto numbers; unique numbers start empty
      state.sheetCols.forEach(function (c) {
        if (c.kind === 'autonumber' || c.kind === 'uniquenumber') delete data[c.key];
      });
      var ins = await sb.from('sheet_rows')
        .insert({ tab_id: state.currentTabId, position: pos, data: data })
        .select(SHEET_ROW_SELECT).single();
      if (ins.error) { toast('Could not paste the row: ' + ins.error.message, 'error', 6000); return; }
      state.sheetRows.push(ins.data);
      state.sheetTotal += 1;
      state.flashRowId = ins.data.id;
      window.setTimeout(function () { state.flashRowId = null; }, 2000);
      toast('Row pasted', 'ok');
    }
    sortLoadedRows();
    renderSheet();
  }

  var multiRowFor = null;   // the row the "Add rows" dialog was opened from

  function openMultiRowModal(row) {
    if (state.sheetQuery) {
      toast('Clear the search first — new empty rows would be hidden by it.', 'warn', 5000);
      return;
    }
    multiRowFor = row;
    $('multirow-count').value = '5';
    $('multirow-where').value = 'below';
    $('multirow-error').classList.add('hidden');
    $('multirow-backdrop').classList.remove('hidden');
    $('multirow-count').focus();
    $('multirow-count').select();
  }

  function closeMultiRowModal() {
    multiRowFor = null;
    $('multirow-backdrop').classList.add('hidden');
  }

  async function onMultiRowAdd() {
    var row = multiRowFor;
    if (!row) return;
    var count = Math.floor(Number($('multirow-count').value));
    if (!(count >= 1 && count <= 100)) {
      var e = $('multirow-error');
      e.textContent = 'Enter a number of rows between 1 and 100.';
      e.classList.remove('hidden');
      return;
    }
    var where = $('multirow-where').value;
    closeMultiRowModal();
    // spread the new rows evenly between the clicked row and its neighbour
    var p = Number(row.position);
    var adj = neighborPosition(row, where);
    if (adj === undefined) return;
    if (adj === null) {
      var list2 = state.sheetRows;
      var i2 = list2.findIndex(function (r) { return r.id === row.id; });
      adj = (i2 + visualStep(where) < 0)
        ? p + count + 1
        : p - (list2.length < state.sheetTotal ? 1 : count + 1);
    }
    var lo = Math.min(p, adj), hi = Math.max(p, adj);
    var step = (hi - lo) / (count + 1);
    var inserts = [];
    for (var k = 1; k <= count; k++) {
      inserts.push({ tab_id: state.currentTabId, position: lo + step * k, data: {} });
    }
    var ins = await sb.from('sheet_rows').insert(inserts).select(SHEET_ROW_SELECT);
    if (ins.error) {
      toast('Could not add rows: ' + ins.error.message, 'error', 6000);
      return;
    }
    state.sheetRows = state.sheetRows.concat(ins.data || []);
    sortLoadedRows();
    state.sheetTotal += (ins.data || []).length;
    renderSheet();
    toast(count + ' empty rows added — double-click their cells to fill them in', 'ok', 4500);
  }

  async function deleteRowDirect(row) {
    if (!canEditCurrentTab()) return;
    if (!window.confirm('Delete this row? This removes it for everyone who can see this tab.')) return;
    var res = await sb.from('sheet_rows').delete().eq('id', row.id).select('id');
    if (res.error) {
      toast('Could not delete: ' + res.error.message, 'error', 6000);
      return;
    }
    state.sheetRows = state.sheetRows.filter(function (r) { return r.id !== row.id; });
    state.sheetTotal = Math.max(0, state.sheetTotal - 1);
    renderSheet();
    toast('Row deleted', 'ok');
  }

  // ---------- drag a row to a new position ----------

  var rowDrag = null;

  function startRowDrag(ev, row) {
    if (isPhone() || !canEditCurrentTab()) return;
    if (ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest('button')) return;  // the pencil
    ev.preventDefault();
    rowDrag = { row: row, startY: ev.clientY, active: false, dropIndex: -1 };
    document.addEventListener('mousemove', onRowDragMove);
    document.addEventListener('mouseup', onRowDragUp);
  }

  function onRowDragMove(e) {
    if (!rowDrag) return;
    if (!rowDrag.active) {
      if (Math.abs(e.clientY - rowDrag.startY) < 5) return;
      rowDrag.active = true;
      document.body.classList.add('row-dragging');
      rowDrag.indicator = el('div', 'row-drop-line', '');
      document.body.appendChild(rowDrag.indicator);
    }
    var trs = document.querySelectorAll('#sheet-body tr');
    var idx = trs.length;
    for (var i = 0; i < trs.length; i++) {
      var r = trs[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    rowDrag.dropIndex = idx;
    var rect = idx < trs.length ? trs[idx].getBoundingClientRect() : null;
    var lastRect = trs.length ? trs[trs.length - 1].getBoundingClientRect() : null;
    var top = rect ? rect.top : (lastRect ? lastRect.bottom : e.clientY);
    var ref = rect || lastRect;
    rowDrag.indicator.style.top = (top - 1) + 'px';
    if (ref) {
      rowDrag.indicator.style.left = ref.left + 'px';
      rowDrag.indicator.style.width = ref.width + 'px';
    }
  }

  async function onRowDragUp() {
    document.removeEventListener('mousemove', onRowDragMove);
    document.removeEventListener('mouseup', onRowDragUp);
    var d = rowDrag;
    rowDrag = null;
    if (!d || !d.active) return;
    document.body.classList.remove('row-dragging');
    if (d.indicator) d.indicator.remove();
    var list = state.renderedRows || [];
    var from = list.findIndex(function (r) { return r.id === d.row.id; });
    var idx = d.dropIndex;
    if (from < 0 || idx < 0 || idx === from || idx === from + 1) return;  // same spot
    var above = idx > 0 ? list[idx - 1] : null;
    var below = idx < list.length ? list[idx] : null;
    var more = state.sheetRows.length < state.sheetTotal;
    var newPos;
    if (above && below) newPos = (Number(above.position) + Number(below.position)) / 2;
    else if (!above && below) {
      // dropped at the very top of the view
      newPos = state.sortDir === 'asc'
        ? Number(below.position) - (more ? 0.5 : 1)   // top = oldest loaded
        : Number(below.position) + 1;                 // top = newest
    } else if (above) {
      // dropped at the very bottom of the view
      newPos = state.sortDir === 'asc'
        ? Number(above.position) + 1                  // bottom = newest
        : Number(above.position) - (more ? 0.5 : 1);  // bottom = oldest loaded
    } else return;
    var cur = state.sheetRows.find(function (r) { return r.id === d.row.id; });
    if (!cur) return;
    var upd = await sb.from('sheet_rows').update({ position: newPos })
      .eq('id', cur.id).eq('version', cur.version).select(SHEET_ROW_SELECT);
    if (upd.error) {
      toast('Could not move the row: ' + upd.error.message, 'error', 6000);
      return;
    }
    if (!upd.data || upd.data.length === 0) {
      toast('This row was just changed by someone else — reloading.', 'warn', 5000);
      await loadSheetRows(true);
      return;
    }
    var i = state.sheetRows.findIndex(function (r) { return r.id === cur.id; });
    if (i >= 0) state.sheetRows[i] = upd.data[0];
    sortLoadedRows();
    renderSheet();
    toast('Row moved', 'ok');
  }

  // ---------- remember where you were (tab is already remembered) ----------

  function scrollKey(tabId) { return 'tenways.scroll.' + tabId; }

  function saveScrollState() {
    var t = currentTab();
    if (!t) return;
    var payload;
    if (t.kind === 'sheet') {
      var w = document.querySelector('#sheet-view .table-wrap');
      payload = { rows: state.sheetRows.length, y: w ? w.scrollTop : 0, x: w ? w.scrollLeft : 0 };
    } else {
      payload = { y: window.scrollY || 0 };
    }
    try { window.localStorage.setItem(scrollKey(t.id), JSON.stringify(payload)); } catch (e) { /* private mode */ }
  }

  function loadScrollState(tabId) {
    try { return JSON.parse(window.localStorage.getItem(scrollKey(tabId)) || 'null'); }
    catch (e) { return null; }
  }

  // Re-load as many pages as were open before, then jump back to the spot.
  async function restoreScrollState() {
    var t = currentTab();
    if (!t) return;
    var s = loadScrollState(t.id);
    if (!s) return;
    if (t.kind === 'sheet') {
      var guard = 0;
      var want = Math.min(Number(s.rows) || 0, state.sheetTotal);
      while (state.sheetQuery === '' && state.sheetRows.length < want && guard++ < 60) {
        await loadSheetRows(false);
      }
      window.setTimeout(function () {
        var w = document.querySelector('#sheet-view .table-wrap');
        if (w) { w.scrollTop = s.y || 0; w.scrollLeft = s.x || 0; }
      }, 400);
    } else {
      window.setTimeout(function () { window.scrollTo(0, s.y || 0); }, 120);
    }
  }

  // ---------- in-place cell editing (double-click, like Excel) ----------

  function startInlineEdit(td, row, col) {
    if (!canEditCurrentTab()) return;
    if (col.kind === 'autonumber') {
      toast('Auto numbers are assigned automatically.', 'warn', 3500);
      return;
    }
    if (col.kind === 'checkbox') {
      var cur = row.data ? row.data[col.key] : null;
      commitInlineValue(row, col, !(cur === true || cur === 'true'));
      return;
    }
    var v = row.data ? row.data[col.key] : null;
    td.classList.add('editing');
    td.replaceChildren();
    var input;
    if (col.kind === 'picklist') {
      input = document.createElement('select');
      var blank = el('option', null, '—');
      blank.value = '';
      input.appendChild(blank);
      (col.options || []).forEach(function (o) {
        var opt = el('option', null, o);
        opt.value = o;
        input.appendChild(opt);
      });
      if (v && (col.options || []).indexOf(String(v)) < 0) {
        var extra = el('option', null, String(v));
        extra.value = String(v);
        input.appendChild(extra);
      }
      input.value = v == null ? '' : String(v);
    } else if (col.kind === 'textarea') {
      input = document.createElement('textarea');
      input.rows = Math.min(5, Math.max(2, String(v == null ? '' : v).split('\n').length));
      input.value = v == null ? '' : String(v);
    } else {
      input = document.createElement('input');
      input.type = (col.kind === 'number' || col.kind === 'uniquenumber') ? 'number'
        : (col.kind === 'date' ? 'date' : 'text');
      input.value = v == null ? '' : (col.kind === 'date' ? String(v).slice(0, 10) : String(v));
    }
    input.className = 'cell-editor';
    td.appendChild(input);
    input.focus();
    if (input.select) { try { input.select(); } catch (e) { /* selects nothing */ } }

    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var val = input.value;
      var newVal = val === '' ? null
        : ((col.kind === 'number' || col.kind === 'uniquenumber') ? Number(val) : val);
      var oldVal = v == null ? '' : String(v);
      if (String(newVal == null ? '' : newVal) === oldVal) { renderSheet(); return; }
      commitInlineValue(row, col, newVal);
    }
    function cancel() {
      if (done) return;
      done = true;
      renderSheet();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (col.kind === 'textarea' && e.shiftKey) return;  // Shift+Enter = new line
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    });
    input.addEventListener('blur', commit);
    if (col.kind === 'picklist') input.addEventListener('change', commit);
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
  }

  // One cell changes; every other key in the row's data stays untouched,
  // with the usual "someone else saved first" protection.
  async function commitInlineValue(row, col, newVal) {
    var cur = state.sheetRows.find(function (r) { return r.id === row.id; }) || row;
    var data = Object.assign({}, cur.data || {});
    data[col.key] = newVal;
    var upd = await sb.from('sheet_rows').update({ data: data })
      .eq('id', cur.id).eq('version', cur.version).select(SHEET_ROW_SELECT);
    if (upd.error) {
      toast('Could not save: ' + upd.error.message, 'error', 6000);
      renderSheet();
      return;
    }
    if (!upd.data || upd.data.length === 0) {
      toast('This row was just changed by someone else — reloading.', 'warn', 5000);
      await loadSheetRows(true);
      return;
    }
    var i = state.sheetRows.findIndex(function (r) { return r.id === cur.id; });
    if (i >= 0) state.sheetRows[i] = upd.data[0];
    renderSheet();
  }

  // ---------- cell links (right-click a text cell) ----------

  var linkModal = null;   // { rowId, colKey, colName }

  function cellLink(row, col) {
    if (col.kind !== 'text' && col.kind !== 'textarea') return null;
    var v = row.data ? row.data[col.key + '__link'] : null;
    if (!v) return null;
    v = String(v);
    return /^(https?:|mailto:|tel:)/i.test(v) ? v : null;
  }

  // "coolautomation.com" is fine — https:// is assumed. Anything that is not
  // a web, mail or phone link is rejected so a cell can never run script.
  function normalizeLink(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}([\/?#:].*)?$/i.test(s)) return 'https://' + s;
    return null;
  }

  function closeCellMenu() {
    var m = $('cell-menu');
    if (m.classList.contains('hidden')) return false;
    m.classList.add('hidden');
    return true;
  }

  function menuItem(label, fn, cls) {
    var b = el('button', cls || null, label);
    b.type = 'button';
    b.addEventListener('click', function () { closeCellMenu(); fn(); });
    return b;
  }

  function cellInSelection(rIdx, cIdx) {
    if (!cellSel) return false;
    return rIdx >= Math.min(cellSel.a.r, cellSel.b.r) && rIdx <= Math.max(cellSel.a.r, cellSel.b.r) &&
           cIdx >= Math.min(cellSel.a.c, cellSel.b.c) && cIdx <= Math.max(cellSel.a.c, cellSel.b.c);
  }

  function openCellMenu(ev, row, col, rIdx, cIdx) {
    ev.preventDefault();
    ev.stopPropagation();
    if (isPhone()) return;
    var td = ev.currentTarget;
    // right-clicking outside the current selection moves the selection there
    if (!cellInSelection(rIdx, cIdx)) {
      cellSel = { a: { r: rIdx, c: cIdx }, b: { r: rIdx, c: cIdx } };
      applyCellSelection();
    }
    var link = cellLink(row, col);
    var canEdit = canEditCurrentTab();
    var m = $('cell-menu');
    m.replaceChildren();
    m.appendChild(menuItem('Copy', function () {
      var tsv = selectionTSV();
      if (tsv == null) return;
      navigator.clipboard.writeText(tsv).then(function () {
        toast('Copied', 'ok', 1500);
      }, function () {
        toast('Press Ctrl+C to copy.', 'warn', 3500);
      });
    }));
    if (canEdit) {
      m.appendChild(menuItem('Paste', function () {
        navigator.clipboard.readText().then(function (text) {
          pasteIntoSelectedCell(text);
        }, function () {
          toast('Press Ctrl+V to paste.', 'warn', 3500);
        });
      }));
      if (col.kind !== 'autonumber') {
        m.appendChild(menuItem('Edit cell…', function () { startInlineEdit(td, row, col); }));
      }
    }
    if (link) m.appendChild(menuItem('Open link', function () {
      window.open(link, '_blank', 'noopener');
    }));
    if (canEdit && (col.kind === 'text' || col.kind === 'textarea')) {
      m.appendChild(menuItem(link ? 'Edit link…' : 'Add link…', function () {
        openLinkModal(row, col);
      }));
      if (link) m.appendChild(menuItem('Remove link', function () {
        saveCellLink(row.id, col.key, '', col.name);
      }));
    }
    m.classList.remove('hidden');
    m.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - m.offsetHeight - 8)) + 'px';
  }

  function openLinkModal(row, col) {
    linkModal = { rowId: row.id, colKey: col.key, colName: col.name };
    var text = sheetValue(row, col);
    $('link-cell-text').textContent = col.name + (text ? ': ' + text : ' (empty cell)');
    $('link-url').value = cellLink(row, col) || '';
    $('link-error').classList.add('hidden');
    $('btn-link-remove').classList.toggle('hidden', !cellLink(row, col));
    $('link-backdrop').classList.remove('hidden');
    $('link-url').focus();
  }

  function closeLinkModal() {
    linkModal = null;
    $('link-backdrop').classList.add('hidden');
  }

  // Writes one cell's link with the usual optimistic lock, keeping every
  // other key in the row's data untouched.
  async function saveCellLink(rowId, colKey, url, colName) {
    var row = state.sheetRows.find(function (r) { return r.id === rowId; });
    if (!row) { toast('That row is no longer loaded.', 'warn', 4000); return; }
    var data = Object.assign({}, row.data || {});
    if (url) data[colKey + '__link'] = url; else delete data[colKey + '__link'];
    var upd = await sb.from('sheet_rows').update({ data: data })
      .eq('id', rowId).eq('version', row.version).select(SHEET_ROW_SELECT);
    if (upd.error) { toast('Could not save the link: ' + upd.error.message, 'error', 6000); return; }
    if (!upd.data || upd.data.length === 0) {
      toast('This row was just changed by someone else — reloading.', 'warn', 5000);
      await loadSheetRows(true);
      return;
    }
    var i = state.sheetRows.findIndex(function (r) { return r.id === rowId; });
    if (i >= 0) state.sheetRows[i] = upd.data[0];
    renderSheet();
    toast(url ? 'Link saved on ' + colName : 'Link removed', 'ok');
  }

  async function onLinkSave() {
    if (!linkModal) return;
    var url = normalizeLink($('link-url').value);
    if (url === null) {
      var e = $('link-error');
      e.textContent = 'That does not look like a link. Use https://…, mailto:… or tel:…';
      e.classList.remove('hidden');
      return;
    }
    var lm = linkModal;
    closeLinkModal();
    await saveCellLink(lm.rowId, lm.colKey, url, lm.colName);
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
        input.className = 'grow-field';
        input.value = v == null ? '' : String(v);
        input.addEventListener('input', function () { autoGrow(input); });
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
      } else if (c.kind === 'number' || c.kind === 'uniquenumber' || c.kind === 'date') {
        input = document.createElement('input');
        input.type = c.kind === 'date' ? 'date' : 'number';
        input.value = v == null ? '' : (c.kind === 'date' ? String(v).slice(0, 10) : String(v));
      } else {
        // free-text cells wrap and grow with their content like the record
        // form's Title: still one logical line (pasted breaks flatten),
        // and Enter still saves the row
        input = document.createElement('textarea');
        input.rows = 1;
        input.className = 'grow-field grow-single';
        input.value = v == null ? '' : String(v);
        input.addEventListener('input', function () {
          if (input.value.indexOf('\n') >= 0 || input.value.indexOf('\r') >= 0) {
            var pos = input.selectionStart;
            input.value = input.value.split(/\r\n|\r|\n/).join(' ');
            input.setSelectionRange(pos, pos);
          }
          autoGrow(input);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); $('btn-row-save').click(); }
        });
      }
      input.id = rowFieldId(c);
      lab.appendChild(input);
      if (c.kind === 'text' || c.kind === 'textarea') {
        var linkVal = (row && row.data) ? String(row.data[c.key + '__link'] || '') : '';
        var linkIn = document.createElement('input');
        linkIn.type = 'text';
        linkIn.id = rowFieldId(c) + '-link';
        linkIn.className = 'row-link-input' + (linkVal ? '' : ' hidden');
        linkIn.placeholder = 'Link (https://…) — optional';
        linkIn.autocomplete = 'off';
        linkIn.spellcheck = false;
        linkIn.value = linkVal;
        var lt = el('button', 'link-toggle' + (linkVal ? ' on' : ''), '\uD83D\uDD17');
        lt.type = 'button';
        lt.title = 'Attach a link to this cell';
        lt.addEventListener('click', function (ev) {
          ev.preventDefault();
          linkIn.classList.toggle('hidden');
          if (!linkIn.classList.contains('hidden')) linkIn.focus();
        });
        lab.querySelector('span').appendChild(lt);
        lab.appendChild(linkIn);
      }
      wrap.appendChild(lab);
    });
  }

  function collectRowData() {
    // Start from the row's existing data so cell links and the values of
    // deleted columns survive a save instead of being silently dropped.
    var data = Object.assign({}, (rowModal && rowModal.origData) || {});
    collectRowData.badLink = null;
    state.sheetCols.forEach(function (c) {
      var input = $(rowFieldId(c));
      if (!input) return;
      if (c.kind === 'checkbox') { data[c.key] = !!input.checked; return; }
      if (c.kind === 'autonumber') return;   // already in the clone; the db assigns new ones
      var val = input.value;
      if (c.kind !== 'textarea' && c.kind !== 'number' && c.kind !== 'date' &&
          typeof val === 'string' && /[\r\n]/.test(val)) {
        val = val.split(/\r\n|\r|\n/).join(' ');
      }
      data[c.key] = val === '' ? null
        : ((c.kind === 'number' || c.kind === 'uniquenumber') ? Number(val) : val);
      if (c.kind === 'text' || c.kind === 'textarea') {
        var li = $(rowFieldId(c) + '-link');
        if (li) {
          var norm = normalizeLink(li.value);
          if (norm === null) collectRowData.badLink = c.name;
          else if (norm) data[c.key + '__link'] = norm;
          else delete data[c.key + '__link'];
        }
      }
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
    rowModal.attachments = [];
    var editable = canEditCurrentTab();
    $('btn-row-attach').disabled = mode !== 'edit';
    $('btn-row-attach').classList.toggle('hidden', !editable);
    $('row-attach-hint').classList.toggle('hidden', mode === 'edit' || !editable);
    renderRowAttachments();
    if (mode === 'edit') rowLoadAttachments();
    $('btn-row-save').classList.toggle('hidden', !editable);
    if (!editable) {
      $('btn-row-delete').classList.add('hidden');
      $('row-fields').querySelectorAll('input, select, textarea').forEach(function (f) {
        f.disabled = true;
      });
      $('row-meta').textContent += ' · view only';
    }
    $('row-backdrop').classList.remove('hidden');
    $('row-fields').querySelectorAll('.grow-field').forEach(function (f) { autoGrow(f); });
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
      if (collectRowData.badLink) {
        setRowError('The link on "' + collectRowData.badLink +
          '" does not look valid. Use https://…, mailto:… or tel:…');
        return;
      }
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
        if (closeCellMenu()) return;               // Escape closes the cell menu first
        if (closeColVisPanel()) return;            // then the columns filter
        if (closeAllPanels()) return;              // then an open dropdown
        if (linkModal) { closeLinkModal(); return; }
        if (!$('multirow-backdrop').classList.contains('hidden')) { closeMultiRowModal(); return; }
        if (catModal.open) { closeCatModal(); return; }
        if (adminModal.open) { closeAdminModal(); return; }
        if (tabModal.open) { closeTabModal(); return; }
        if (rowModal) { closeRowModal(); return; }
        if (cellSel) { clearCellSelection(); return; }
        if (rowClipboard) {
          rowClipboard = null;
          renderSheet();
          toast('Cut / copy cancelled', 'ok', 1800);
          return;
        }
        if (state.modal) closeModal();             // next one closes the modal
      }
    });
    document.addEventListener('mousedown', function (e) {
      // the Columns filter panel shares the dropdown styling; without this
      // guard any press inside it closed it before the tick registered
      if (!e.target.closest || !e.target.closest('.msel, .colvis')) closeAllPanels();
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
    $('btn-row-attach').addEventListener('click', function () { $('row-attach-input').click(); });
    $('row-attach-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (files.length) rowUploadAttachments(files);
    });
    $('btn-multirow-add').addEventListener('click', onMultiRowAdd);
    $('btn-multirow-cancel').addEventListener('click', closeMultiRowModal);
    $('multirow-count').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onMultiRowAdd(); }
    });
    $('multirow-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeMultiRowModal();
    });
    $('btn-link-save').addEventListener('click', onLinkSave);
    $('btn-link-cancel').addEventListener('click', closeLinkModal);
    $('btn-link-remove').addEventListener('click', function () {
      var lm = linkModal;
      closeLinkModal();
      if (lm) saveCellLink(lm.rowId, lm.colKey, '', lm.colName);
    });
    $('link-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onLinkSave(); }
    });
    $('link-backdrop').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closeLinkModal();
    });
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest || !e.target.closest('#cell-menu')) closeCellMenu();
      if (!e.target.closest || !e.target.closest('.colvis')) closeColVisPanel();
    });
    document.addEventListener('mouseup', function () { cellDragging = false; });
    document.addEventListener('copy', function (e) {
      var el2 = document.activeElement;
      if (el2 && (el2.tagName === 'INPUT' || el2.tagName === 'TEXTAREA' || el2.tagName === 'SELECT')) return;
      if (rowModal || state.modal || linkModal || tabModal.open) return;
      var tsv = selectionTSV();
      if (tsv == null) return;
      e.clipboardData.setData('text/plain', tsv);
      e.preventDefault();
      toast('Copied', 'ok', 1500);
    });
    document.addEventListener('paste', function (e) {
      var el2 = document.activeElement;
      if (el2 && (el2.tagName === 'INPUT' || el2.tagName === 'TEXTAREA' || el2.tagName === 'SELECT')) return;
      if (rowModal || state.modal || linkModal || tabModal.open) return;
      if (!cellSel) return;
      e.preventDefault();
      pasteIntoSelectedCell(e.clipboardData.getData('text/plain'));
    });
    var scrollSaveTimer = null;
    function scheduleScrollSave() {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(saveScrollState, 400);
    }
    var sheetWrap = document.querySelector('#sheet-view .table-wrap');
    if (sheetWrap) sheetWrap.addEventListener('scroll', scheduleScrollSave);
    if (sheetWrap) sheetWrap.addEventListener('scroll', positionFillHandle);
    $('fill-handle').addEventListener('mousedown', startFillDrag);
    $('sheet-sortdir').addEventListener('change', function () {
      state.sortDir = $('sheet-sortdir').value === 'asc' ? 'asc' : 'desc';
      try { window.localStorage.setItem(sortDirKey(), state.sortDir); } catch (e) { /* private mode */ }
      clearCellSelection();
      renderSheet();   // pure display flip — the loaded rows just turn over
      var w = document.querySelector('#sheet-view .table-wrap');
      if (w) w.scrollTop = 0;
    });
    function sheetScroller() {
      return isPhone() ? null : document.querySelector('#sheet-view .table-wrap');
    }
    $('btn-goto-top').addEventListener('click', function () {
      var w = sheetScroller();
      if (w) w.scrollTop = 0; else window.scrollTo(0, 0);
    });
    $('btn-goto-end').addEventListener('click', function () {
      var w = sheetScroller();
      if (w) w.scrollTop = w.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
    });
    window.addEventListener('scroll', scheduleScrollSave);
    window.addEventListener('beforeunload', saveScrollState);
    $('btn-colvis').addEventListener('click', toggleColVisPanel);
    document.addEventListener('scroll', function () { closeCellMenu(); }, true);
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
