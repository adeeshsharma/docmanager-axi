// Escaping "<" as a unicode escape (not just "</script>" specifically) is
// the same defensive posture link-discovery.js's own comment on this exact
// problem class would apply - a fixed color enum makes this untriggerable
// in practice today, but the escaping holds regardless of what a future
// caller might pass, not just what docmanager itself currently produces.
function safeJsonPayload(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Builds the full injected client-side behavior for per-version highlights:
 * replaying stored highlights on load, showing a color-swatch toolbar on
 * text selection, and a hover-triggered remove affordance on an existing
 * highlight. Always returns a script, even for a version with zero stored
 * highlights - unlike rewriteLinks()'s rewroteAny gate (where "nothing to
 * rewrite" really does mean nothing to do), this script has a second job
 * beyond replaying existing highlights: enabling the user to CREATE the
 * first one via selection, which is needed on every document regardless of
 * whether any highlights exist yet. Gating this on an empty array would
 * silently disable highlight creation for the single most common case (a
 * document with none yet) - caught via manual browser verification, not
 * hypothetical.
 *
 * Coordinate system: character offset into the document's flattened
 * VISIBLE text (script/style excluded), walked in document order - see
 * the design doc's own reasoning for why this, not a DOM structural path,
 * is what makes independent create/remove of multiple highlights safe.
 */
export function buildHighlightScript(highlights) {
  const payload = safeJsonPayload(highlights ?? []);

  return `<script>(function(){
  var HIGHLIGHTS = ${payload};
  var COLORS = { yellow: '#fff59d', green: '#a5d6a7', blue: '#90caf9', pink: '#f48fb1' };

  function isVisibleTextNode(node) {
    var el = node.parentNode;
    while (el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style') return false;
      el = el.parentNode;
    }
    return true;
  }

  function collectTextNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (isVisibleTextNode(node)) nodes.push(node);
    }
    return nodes;
  }

  // The offset of a specific (text node, local offset) position, walking
  // the SAME node order collectTextNodes() always produces - the single
  // source of truth both capture (selection -> offset) and replay
  // (offset -> DOM position) agree on.
  function offsetOfPosition(container, localOffset) {
    var nodes = collectTextNodes();
    var total = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === container) return total + localOffset;
      total += nodes[i].nodeValue.length;
    }
    return null;
  }

  // A Range boundary's container is a Text node in the common case (a real
  // mouse-drag selection over rendered text). The rarer case - a boundary
  // landing between child nodes rather than mid-text - normalizes to the
  // first text descendant of the child at that position.
  function normalizeBoundary(container, offsetInContainer) {
    if (container.nodeType === Node.TEXT_NODE) return { node: container, offset: offsetInContainer };
    var child = container.childNodes[offsetInContainer] || container.childNodes[container.childNodes.length - 1];
    if (!child) return null;
    var walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, null);
    var text = walker.nextNode();
    if (!text) return null;
    return { node: text, offset: container.childNodes[offsetInContainer] ? 0 : text.nodeValue.length };
  }

  function computeOffset(container, offsetInContainer) {
    var boundary = normalizeBoundary(container, offsetInContainer);
    if (!boundary) return null;
    return offsetOfPosition(boundary.node, boundary.offset);
  }

  function wrapSlice(node, localStart, localEnd, color, id) {
    if (localStart >= localEnd) return;
    if (localEnd < node.nodeValue.length) node.splitText(localEnd);
    var target = localStart > 0 ? node.splitText(localStart) : node;
    var mark = document.createElement('mark');
    mark.style.background = COLORS[color] || COLORS.yellow;
    mark.setAttribute('data-docmanager-highlight-id', id);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }

  // Every overlapping text node's own (node, localStart, localEnd) is
  // computed up front, against ONE fresh walk, before any splitting for
  // THIS highlight happens - splitText() only ever affects the single node
  // it's called on (inserting a new sibling right after it), so it never
  // invalidates another already-identified target in this same list.
  function wrapRange(startOffset, endOffset, color, id) {
    var nodes = collectTextNodes();
    var consumed = 0;
    var targets = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var len = node.nodeValue.length;
      var nodeStart = consumed;
      var nodeEnd = consumed + len;
      if (nodeEnd > startOffset && nodeStart < endOffset) {
        targets.push({
          node: node,
          localStart: Math.max(startOffset, nodeStart) - nodeStart,
          localEnd: Math.min(endOffset, nodeEnd) - nodeStart,
        });
      }
      consumed = nodeEnd;
    }
    targets.forEach(function(t) { wrapSlice(t.node, t.localStart, t.localEnd, color, id); });
  }

  // Replayed in stored (creation) order - never re-sorted. See the design
  // doc's own reasoning: offsets are stable regardless of other highlights,
  // but replay must still reproduce the same sequence capture-time selection
  // was made against, across separate sessions.
  //
  // injectIntoHead() places this script as the FIRST CHILD of <body> (or
  // inside <head>, if the served document has one) - it executes
  // synchronously at that exact point in parsing, before any of the
  // document's own real content has been added to the DOM yet. A
  // document.body truthiness check is NOT enough to guard against this:
  // <body> itself already exists by the time a script placed right after
  // its opening tag runs, but body has zero children at that instant -
  // collectTextNodes() would walk an empty body and silently find nothing
  // to wrap, no error, no highlight. Caught via manual browser verification
  // against a real fixture with no explicit <head> tag - the try/catch
  // below was silently swallowing this exact case, masking it as if it
  // were "a genuinely bad stored record," which it wasn't. Always
  // deferring to DOMContentLoaded (never conditionally) is what actually
  // guarantees the rest of the document has been parsed first.
  document.addEventListener('DOMContentLoaded', function() {
    HIGHLIGHTS.forEach(function(h) {
      try { wrapRange(h.startOffset, h.endOffset, h.color, h.id); } catch (e) { /* one bad record must never break the rest */ }
    });
  });

  var toolbar = null;
  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  function showToolbar(rect) {
    hideToolbar();
    toolbar = document.createElement('div');
    toolbar.style.cssText = 'position:absolute;display:flex;gap:4px;padding:4px;background:#22252b;border-radius:6px;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    toolbar.style.left = (rect.left + window.scrollX) + 'px';
    toolbar.style.top = (rect.top + window.scrollY - 36) + 'px';
    ['yellow', 'green', 'blue', 'pink'].forEach(function(color) {
      var swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.style.cssText = 'width:18px;height:18px;border-radius:50%;border:none;cursor:pointer;background:' + COLORS[color] + ';';
      swatch.addEventListener('mousedown', function(event) {
        event.preventDefault(); // keep the native selection alive until we've read it
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hideToolbar(); return; }
        var range = sel.getRangeAt(0);
        var startOffset = computeOffset(range.startContainer, range.startOffset);
        var endOffset = computeOffset(range.endContainer, range.endOffset);
        hideToolbar();
        sel.removeAllRanges();
        if (startOffset == null || endOffset == null || startOffset >= endOffset) return;
        wrapRange(startOffset, endOffset, color, 'pending-' + Date.now());
        parent.postMessage({ source: 'docmanager-highlight-create', color: color, startOffset: startOffset, endOffset: endOffset }, '*');
      });
      toolbar.appendChild(swatch);
    });
    document.body.appendChild(toolbar);
  }

  document.addEventListener('mouseup', function(event) {
    if (toolbar && toolbar.contains(event.target)) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideToolbar(); return; }
    showToolbar(sel.getRangeAt(0).getBoundingClientRect());
  });
  document.addEventListener('mousedown', function(event) {
    if (toolbar && !toolbar.contains(event.target)) hideToolbar();
  });

  // Hover-triggered remove affordance, deliberately not click-triggered -
  // a highlight can sit on top of a link's own text, and the link's
  // existing click-to-navigate handler (LINK_CLICK_SCRIPT) must keep
  // working completely unaffected by this feature.
  var removeBtn = null;
  var hideRemoveTimer = null;
  function hideRemoveBtn() {
    if (removeBtn) { removeBtn.remove(); removeBtn = null; }
  }
  document.addEventListener('mouseover', function(event) {
    var mark = event.target.closest ? event.target.closest('mark[data-docmanager-highlight-id]') : null;
    if (!mark) return;
    clearTimeout(hideRemoveTimer);
    hideRemoveBtn();
    var rect = mark.getBoundingClientRect();
    removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '\\u00d7';
    removeBtn.style.cssText = 'position:absolute;left:' + (rect.right + window.scrollX - 8) + 'px;top:' + (rect.top + window.scrollY - 10) + 'px;width:16px;height:16px;line-height:14px;padding:0;border-radius:50%;border:none;background:#22252b;color:#fff;font-size:11px;cursor:pointer;z-index:2147483647;';
    removeBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    removeBtn.addEventListener('click', function() {
      var id = mark.getAttribute('data-docmanager-highlight-id');
      var parentNode = mark.parentNode;
      while (mark.firstChild) parentNode.insertBefore(mark.firstChild, mark);
      parentNode.removeChild(mark);
      parentNode.normalize();
      hideRemoveBtn();
      parent.postMessage({ source: 'docmanager-highlight-remove', highlightId: id }, '*');
    });
    document.body.appendChild(removeBtn);
  });
  document.addEventListener('mouseout', function(event) {
    var mark = event.target.closest ? event.target.closest('mark[data-docmanager-highlight-id]') : null;
    if (!mark && (!removeBtn || !event.relatedTarget || !removeBtn.contains(event.relatedTarget))) {
      hideRemoveTimer = setTimeout(hideRemoveBtn, 200);
    }
  });
})();</script>`;
}
