#!/usr/bin/env python3
"""Make the static mirror answer the three Deki reads that Conductor's IDEA capture performs.

IDEA discovers a book through `GET /@api/deki/pages/{id}` (page), `.../security` and
`.../tree`, then fetches each page's HTML anonymously and requires `id="pageIDHolder"`
plus a `mt-content-container` root. The mirror is a rendered copy with neither page ids
nor that API, so this script:

  * assigns every page under site/Books/<book>/ a stable numeric id, persisted in
    site/@api/deki/_ids.json so re-runs and new imports never move an existing id;
  * writes site/@api/deki/pages/<id>/{page,security,tree}.json (Caddy rewrites the
    Deki paths onto those files); every page is Public - the mirror only holds
    openly licensed public books;
  * stamps each page's index.html with the id holder and the content-root class.

Run after every import_book.py: `python3 idea_index.py --site /opt/libretexts/mirror/site`.
Demo infrastructure for libretexts.dev only; production Conductor talks to CXone directly.
"""
import argparse
import datetime as _dt
import html as _html
import json
import re
from pathlib import Path

BOOKS_DIR = "Books"
FIRST_ID = 100000
PUBLIC = {"permissions.page": {"restriction": {"#text": "Public"}}}
_HOST = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
_HOLDER = re.compile(r'<div id="pageIDHolder" hidden>\d+</div>\n?')
_MAIN = re.compile(r'<main\b([^>]*\bid="main-content"[^>]*)>')
_CLASS = re.compile(r'\bclass="([^"]*)"')
_TITLE = re.compile(r"<title>(.*?)</title>", re.S)


def _pages(site: Path) -> list[Path]:
    """Every rendered page under Books/<book>/..., as paths relative to the site root."""
    books = site / BOOKS_DIR
    if not books.is_dir():
        return []
    found = []
    for book in sorted(p for p in books.iterdir() if p.is_dir()):
        # Cover first, then breadth-first, so a book's cover gets the lowest id.
        for index in sorted(book.rglob("index.html"), key=lambda p: (len(p.parts), str(p))):
            found.append(index.parent.relative_to(site))
    return found


def _load_ids(site: Path) -> dict[str, str]:
    path = site / "@api" / "deki" / "_ids.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _save_ids(site: Path, ids: dict[str, str]) -> None:
    path = site / "@api" / "deki" / "_ids.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ids, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _title(html: str, fallback: str) -> str:
    match = _TITLE.search(html)
    text = _html.unescape(re.sub(r"\s+", " ", match.group(1)).strip()) if match else ""
    return re.sub(r"\s+-\s+Dev LibreTexts$", "", text) or fallback


def _node(rel: str, ids: dict[str, str], children: dict[str, list[str]]) -> dict:
    node = {"@id": ids[rel]}
    kids = children.get(rel, [])
    if kids:
        node["subpages"] = {"@count": str(len(kids)), "page": [_node(k, ids, children) for k in kids]}
    return node


def _with_root_class(main_tag_match: re.Match) -> str:
    attrs = main_tag_match.group(1)
    existing = _CLASS.search(attrs)
    if existing is None:
        return f"<main{attrs} class=\"mt-content-container\">"
    classes = existing.group(1).split()
    if "mt-content-container" not in classes:
        classes.append("mt-content-container")
    return "<main" + attrs[: existing.start()] + f'class="{" ".join(classes)}"' + attrs[existing.end():] + ">"


def _stamp(html: str, page_id: str) -> str:
    html = _HOLDER.sub("", html)
    if not _MAIN.search(html):
        raise ValueError('page has no <main id="main-content"> to use as the content root')
    html = _MAIN.sub(_with_root_class, html, count=1)
    return _MAIN.sub(lambda m: f'<div id="pageIDHolder" hidden>{page_id}</div>\n{m.group(0)}', html, count=1)


def build(site: Path, host: str) -> dict[str, str]:
    """Index the mirror; returns {relative page path: page id}."""
    if not _HOST.match(host):
        raise ValueError(f"host must be a bare lowercase hostname, got {host!r}")
    site = Path(site)
    ids = _load_ids(site)
    rels = [str(p) for p in _pages(site)]
    next_id = max([FIRST_ID - 1, *(int(v) for v in ids.values())]) + 1
    for rel in rels:
        if rel not in ids:
            ids[rel] = str(next_id)
            next_id += 1
    present = {rel: ids[rel] for rel in rels}
    _save_ids(site, ids)

    children: dict[str, list[str]] = {}
    parent: dict[str, str | None] = {}
    for rel in rels:
        up = str(Path(rel).parent)
        parent[rel] = up if up in present else None
        if parent[rel] is not None:
            children.setdefault(up, []).append(rel)

    api = site / "@api" / "deki" / "pages"
    for rel in rels:
        index = site / rel / "index.html"
        html = index.read_text(encoding="utf-8")
        modified = _dt.datetime.fromtimestamp(index.stat().st_mtime, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        page = {
            "@id": present[rel],
            "title": _title(html, Path(rel).name),
            "uri.ui": f"https://{host}/{rel}/",
            "date.modified": modified,
            "security": PUBLIC,
        }
        if parent[rel] is not None:
            page["page.parent"] = {"@id": present[parent[rel]]}
        out = api / present[rel]
        out.mkdir(parents=True, exist_ok=True)
        (out / "page.json").write_text(json.dumps(page, indent=1) + "\n", encoding="utf-8")
        (out / "security.json").write_text(json.dumps(PUBLIC, indent=1) + "\n", encoding="utf-8")
        (out / "tree.json").write_text(json.dumps({"page": _node(rel, present, children)}, indent=1) + "\n", encoding="utf-8")
        stamped = _stamp(html, present[rel])
        if stamped != html:
            index.write_text(stamped, encoding="utf-8")
    return present


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--site", required=True, type=Path, help="mirror site root (contains Books/)")
    ap.add_argument("--host", default="library.libretexts.dev", help="public hostname of the mirror")
    args = ap.parse_args()
    ids = build(args.site, args.host)
    books = {rel.split("/")[1] for rel in ids}
    print(json.dumps({"pages": len(ids), "books": sorted(books), "api": str(args.site / "@api" / "deki" / "pages")}))


if __name__ == "__main__":
    main()
