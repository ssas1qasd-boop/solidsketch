#!/usr/bin/env python3
"""Check that assets/android-bridge.js calls the Java bridge with the right arity.

Android WebView's Java bridge (Chromium GinJavaBoundObject::FindMethod) resolves a
JS call by method NAME and ARGUMENT COUNT, and only among public methods annotated
with @android.webkit.JavascriptInterface. A call with an extra or missing argument
fails at runtime with "Error invoking <name>: Method not found", so this check
compares every `bridge.<name>(...)` / `SolidSketchAndroid.<name>(...)` call in the
JS with the compiled class.

Usage: check_bridge.py DownloadBridge.class android-bridge.js [--json]
Exit status 0 = every call matches an exposed method, 1 = mismatch.
"""
import json
import re
import struct
import sys

JSI = "Landroid/webkit/JavascriptInterface;"
ACC_PUBLIC = 0x0001


def descriptor_arity(desc):
    i, n = 1, 0  # skip '('
    while desc[i] != ')':
        while desc[i] == '[':
            i += 1
        if desc[i] == 'L':
            i = desc.index(';', i)
        i += 1
        n += 1
    return n


def skip_element_value(b, p):
    tag = chr(b[p])
    p += 1
    if tag in 'BCDFIJSZsc':
        return p + 2
    if tag == 'e':
        return p + 4
    if tag == '@':
        return skip_annotation(b, p)
    if tag == '[':
        n = struct.unpack_from('>H', b, p)[0]
        p += 2
        for _ in range(n):
            p = skip_element_value(b, p)
        return p
    raise SystemExit('bad annotation element tag %r' % tag)


def skip_annotation(b, p):
    n_pairs = struct.unpack_from('>H', b, p + 2)[0]
    p += 4
    for _ in range(n_pairs):
        p = skip_element_value(b, p + 2)
    return p


def exposed_methods(class_path):
    """Return {name: sorted list of arities} of public @JavascriptInterface methods."""
    data = open(class_path, 'rb').read()
    if data[:4] != b'\xca\xfe\xba\xbe':
        raise SystemExit('not a class file: ' + class_path)
    pos = 10
    count = struct.unpack_from('>H', data, 8)[0]
    utf8 = {}
    i = 1
    while i < count:
        tag = data[pos]
        if tag == 1:
            ln = struct.unpack_from('>H', data, pos + 1)[0]
            utf8[i] = data[pos + 3:pos + 3 + ln].decode('utf-8', 'replace')
            pos += 3 + ln
        elif tag in (7, 8, 16, 19, 20):
            pos += 3
        elif tag == 15:
            pos += 4
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            pos += 5
        elif tag in (5, 6):
            pos += 9
            i += 1  # long/double take two slots
        else:
            raise SystemExit('bad constant pool tag %d in %s' % (tag, class_path))
        i += 1
    pos += 6  # access, this, super
    n_if = struct.unpack_from('>H', data, pos)[0]
    pos += 2 + 2 * n_if

    def members(pos, want_methods):
        n = struct.unpack_from('>H', data, pos)[0]
        pos += 2
        out = []
        for _ in range(n):
            acc, name_i, desc_i, n_attr = struct.unpack_from('>HHHH', data, pos)
            pos += 8
            annotated = False
            for _ in range(n_attr):
                a_name, a_len = struct.unpack_from('>HI', data, pos)
                body = data[pos + 6:pos + 6 + a_len]
                pos += 6 + a_len
                if utf8.get(a_name) == 'RuntimeVisibleAnnotations':
                    num = struct.unpack_from('>H', body, 0)[0]
                    p = 2
                    for _ in range(num):
                        if utf8.get(struct.unpack_from('>H', body, p)[0]) == JSI:
                            annotated = True
                        p = skip_annotation(body, p)
            if want_methods:
                out.append((acc, utf8[name_i], utf8[desc_i], annotated))
        return pos, out

    pos, _ = members(pos, False)       # fields
    pos, methods = members(pos, True)  # methods
    exposed = {}
    for acc, name, desc, annotated in methods:
        if annotated and acc & ACC_PUBLIC:
            exposed.setdefault(name, set()).add(descriptor_arity(desc))
    return {k: sorted(v) for k, v in exposed.items()}


def strip_comments(src):
    out, i, n, quote = [], 0, len(src), None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
        elif c in '\'"`':
            quote = c
            out.append(c)
            i += 1
        elif src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            out.append(' ' * ((n if j < 0 else j + 2) - i))
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def js_calls(js_path):
    """Return [(line, name, arity)] for bridge.<name>(...) calls."""
    src = strip_comments(open(js_path, encoding='utf-8').read())
    calls = []
    for m in re.finditer(r'\b(?:bridge|SolidSketchAndroid)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(', src):
        i, depth, commas, quote, empty = m.end(), 0, 0, None, True
        while i < len(src):
            c = src[i]
            if quote:
                if c == '\\':
                    i += 1
                elif c == quote:
                    quote = None
            elif c in '\'"`':
                quote, empty = c, False
            elif c in '([{':
                depth, empty = depth + 1, False
            elif c in ')]}':
                if depth == 0:
                    break
                depth -= 1
            elif c == ',' and depth == 0:
                commas += 1
            elif not c.isspace():
                empty = False
            i += 1
        calls.append((src.count('\n', 0, m.start()) + 1, m.group(1), 0 if empty else commas + 1))
    return calls


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    exposed = exposed_methods(argv[1])
    calls = js_calls(argv[2])
    if '--json' in argv:
        print(json.dumps(exposed))
        return 0
    bad = 0
    print('    Java @JavascriptInterface: ' + ', '.join('%s/%s' % (k, '|'.join(map(str, v))) for k, v in sorted(exposed.items())))
    for line, name, arity in calls:
        ok = arity in exposed.get(name, [])
        bad += not ok
        print('    %s js:%d %s(%d args)%s' % ('ok  ' if ok else 'FAIL', line, name, arity,
              '' if ok else '  -> Java has ' + (name + '/' + '|'.join(map(str, exposed[name])) if name in exposed else 'no such @JavascriptInterface method')))
    if not calls:
        print('    FAIL no bridge calls found in ' + argv[2])
        return 1
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
