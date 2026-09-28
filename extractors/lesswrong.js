(function() {
// extractors/lesswrong.js — LessWrong / Alignment Forum via ForumMagnum's GraphQL API:
// the post's source markdown (LaTeX intact) plus the complete comment tree.

const ClipMD = window.ClipMD;
const T = ClipMD.transcript;

const HOST = /(^|\.)(lesswrong\.com|alignmentforum\.org)$/;
// /posts/<id>[/slug] and sequence pages /s/<seq>/p/<id>, which serve the post in place.
const POST_PATH = /\/(?:posts|p)\/([A-Za-z0-9]+)(?:\/|$)/;
const COMMENT_LIMIT = 10000;

const POST_QUERY = `query ($id: String) { post(input: {selector: {_id: $id}}) { result {
  title postedAt baseScore commentCount user { displayName } contents { markdown } } } }`;
const COMMENTS_QUERY = `query ($postId: String!, $limit: Int!) {
  comments(input: {terms: {view: "postCommentsTop", postId: $postId, limit: $limit}}) { results {
    _id parentCommentId deleted baseScore postedAt user { displayName } contents { markdown } } } }`;

async function gql(query, variables) {
  const resp = await fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.errors?.length) throw new Error('GraphQL: ' + body.errors.map((e) => e.message).join('; '));
  return body.data;
}

// Nested <comment> tags, siblings ordered by karma. Deleted comments stay as placeholders
// so their replies keep their place; replies whose parent the API didn't return are
// attached at top level and marked.
function renderComments(comments, warnings) {
  const byId = new Map(comments.map((c) => [c._id, c]));
  const children = new Map();
  const roots = [];
  for (const c of comments) {
    if (c.parentCommentId && byId.has(c.parentCommentId)) {
      if (!children.has(c.parentCommentId)) children.set(c.parentCommentId, []);
      children.get(c.parentCommentId).push(c);
    } else {
      roots.push(c);
    }
  }
  const byKarma = (a, b) => (b.baseScore ?? 0) - (a.baseScore ?? 0);

  function render(c) {
    const replies = (children.get(c._id) || []).sort(byKarma).map(render);
    if (c.deleted) return T.tag('comment', { id: c._id, deleted: true }, T.join(replies));
    if (c.contents?.markdown == null) warnings.push(`comment ${c._id} has no markdown`);
    const orphaned = c.parentCommentId && !byId.has(c.parentCommentId);
    return T.tag('comment', {
      id: c._id,
      author: c.user?.displayName,
      karma: c.baseScore,
      date: c.postedAt && T.time(c.postedAt),
      orphan_of: orphaned ? c.parentCommentId : undefined,
    }, T.join([c.contents?.markdown, ...replies]));
  }
  return roots.sort(byKarma).map(render);
}

ClipMD.extractors.lesswrong = {
  id: 'lesswrong',
  matches: () => HOST.test(location.hostname) && POST_PATH.test(location.pathname),

  async extract() {
    const postId = POST_PATH.exec(location.pathname)[1];
    const warnings = [];
    const [{ post }, { comments }] = await Promise.all([
      gql(POST_QUERY, { id: postId }),
      gql(COMMENTS_QUERY, { postId, limit: COMMENT_LIMIT }),
    ]);
    const p = post?.result;
    if (!p) throw new Error(`post ${postId} not found`);
    if (p.contents?.markdown == null) throw new Error(`post ${postId} has no markdown in the API response`);

    const all = comments.results;
    const live = all.filter((c) => !c.deleted).length;
    if (all.length >= COMMENT_LIMIT) warnings.push(`comment list hit the ${COMMENT_LIMIT} limit — thread is truncated`);
    if (live < (p.commentCount ?? 0)) warnings.push(`${live} of ${p.commentCount} comments returned by the API`);

    const sections = [p.contents.markdown];
    if (all.length) sections.push(T.tag('comments', { count: live }, T.join(renderComments(all, warnings))));

    return {
      meta: {
        title: p.title,
        url: ClipMD.getCanonicalUrl(),
        author: p.user?.displayName,
        date: p.postedAt ? ClipMD.isoDate(p.postedAt) : undefined,
        type: location.hostname.includes('alignmentforum') ? 'alignment-forum' : 'lesswrong',
        karma: p.baseScore,
        comments: live,
      },
      markdown: T.join(sections),
      warnings,
    };
  },
};
})();
