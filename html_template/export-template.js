(function () {
	var tree = JSON.parse(document.getElementById('conversation-tree').textContent);
	var msgMap = new Map(tree.map(function (m) { return [m.id, m] }));
	var childMap = new Map();
	tree.forEach(function (m) {
		if (!childMap.has(m.parent)) childMap.set(m.parent, []);
		childMap.get(m.parent).push(m.id);
	});
	function deepestLeaf(id) {
		while (childMap.has(id) && childMap.get(id).length > 0) {
			var ch = childMap.get(id);
			id = ch[ch.length - 1];
		}
		return id;
	}
	var params = new URLSearchParams(location.search);
	var leaf = params.get('leaf') || document.body.dataset.defaultLeaf;
	var path = new Set();
	var id = leaf;
	while (id && msgMap.has(id)) {
		path.add(id);
		id = msgMap.get(id).parent;
	}
	path.forEach(function (mid) {
		var el = document.getElementById('msg-' + mid);
		if (el) el.style.display = '';
		var siblings = childMap.get(msgMap.get(mid).parent);
		if (siblings && siblings.length > 1) {
			var idx = siblings.indexOf(mid);
			var nav = document.createElement('span');
			nav.className = 'branch-nav';
			var leftSvg = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M13.2402 3.07224C13.4389 2.95131 13.7018 2.98306 13.8662 3.16013C14.0305 3.3371 14.0422 3.60087 13.9072 3.79001L13.8399 3.86619L7.2334 9.99998L13.8399 16.1338C14.0422 16.3216 14.054 16.6375 13.8662 16.8398C13.6784 17.0422 13.3625 17.054 13.1602 16.8662L6.16016 10.3662L6.0918 10.289C6.03247 10.2053 6 10.1043 6 9.99998C6.00002 9.86097 6.05829 9.72836 6.16016 9.63377L13.1602 3.13376L13.2402 3.07224Z"/></svg>';
			var rightSvg = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6.13378 3.16011C6.29824 2.98312 6.5611 2.95129 6.75976 3.07221L6.83984 3.13374L13.8398 9.63377C13.9417 9.72836 14 9.86101 14 9.99999C14 10.1043 13.9675 10.2053 13.9082 10.289L13.8398 10.3662L6.83984 16.8662C6.6375 17.054 6.32166 17.0421 6.13378 16.8399C5.94599 16.6375 5.95783 16.3217 6.16015 16.1338L12.7666 9.99999L6.16015 3.86616L6.09277 3.78999C5.95776 3.60085 5.96954 3.33709 6.13378 3.16011Z"/></svg>';
			var h = '';
			if (idx > 0) {
				h += '<a class="branch-btn" href="?leaf=' + deepestLeaf(siblings[idx - 1]) + '#msg-' + siblings[idx - 1] + '">' + leftSvg + '</a>';
			} else {
				h += '<span class="branch-btn disabled">' + leftSvg + '</span>';
			}
			h += '<span class="branch-count">' + (idx + 1) + ' / ' + siblings.length + '</span>';
			if (idx < siblings.length - 1) {
				h += '<a class="branch-btn" href="?leaf=' + deepestLeaf(siblings[idx + 1]) + '#msg-' + siblings[idx + 1] + '">' + rightSvg + '</a>';
			} else {
				h += '<span class="branch-btn disabled">' + rightSvg + '</span>';
			}
			nav.innerHTML = h;
			el.querySelector('.msg-footer').prepend(nav);
		}
	});
	if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
	var isDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
	var btn = document.getElementById('theme-toggle');
	function applyTheme() { document.documentElement.classList.toggle('dark', isDark); btn.textContent = isDark ? '\u2600' : '\u263D'; }
	applyTheme();
	btn.onclick = function () { isDark = !isDark; applyTheme(); };

	// Shown on hover, in the reader's locale (claude.ai's action-bar timestamp, but absolute: an archive
	// read years later shouldn't say "2 minutes ago").
	document.querySelectorAll('.msg[data-timestamp]').forEach(function (msg) {
		var ts = parseInt(msg.getAttribute('data-timestamp'), 10);
		if (!ts) return;
		var date = new Date(ts);
		var span = msg.querySelector('.msg-timestamp');
		span.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
		span.title = date.toLocaleString();
	});

	document.querySelectorAll('.text-content pre code').forEach(function (code) {
		var pre = code.parentElement;
		var btn = document.createElement('button');
		btn.className = 'copy-btn';
		btn.textContent = 'Copy';
		btn.onclick = function () {
			navigator.clipboard.writeText(code.textContent).then(function () {
				btn.textContent = 'Copied!';
				setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
			});
		};
		pre.style.position = 'relative';
		pre.appendChild(btn);
	});
})();