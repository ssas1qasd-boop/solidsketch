#!/usr/bin/env python3
"""Merge the aapt2-linked APK and classes.dex into one deterministic, aligned, unsigned APK.

What this does (the zipalign -p 4 equivalent, done before signing):
  * entry order: AndroidManifest.xml, classes*.dex, resources.arsc, res/..., assets/..., rest
  * resources.arsc is always STORED (required for targetSdk >= 30)
  * PNGs and other entries aapt2 left uncompressed stay STORED; everything else is DEFLATED
  * every STORED entry's data starts on a 4-byte boundary (4096 for .so files), padded via
    the local header extra field (0xd935 alignment record, the same one apksig/zipalign use)
  * fixed timestamps so identical inputs give an identical unsigned APK

Usage: python3 -I package.py BASE.apk OUT.apk FILE=ARCHIVE_NAME [FILE=ARCHIVE_NAME ...]
"""
import struct
import sys
import zipfile
import zlib

DOS_TIME = (1 << 11) | (1 << 5) | 1        # 01:01:02
DOS_DATE = ((1981 - 1980) << 9) | (1 << 5) | 1  # 1981-01-01
ALIGN_EXTRA_ID = 0xD935


def order_key(name):
    if name == "AndroidManifest.xml":
        return (0, name)
    if name.startswith("classes") and name.endswith(".dex") and "/" not in name:
        return (1, name)
    if name == "resources.arsc":
        return (2, name)
    if name.startswith("res/"):
        return (3, name)
    if name.startswith("assets/"):
        return (4, name)
    return (5, name)


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    base, out = argv[1], argv[2]
    entries = {}  # name -> (data, stored?)
    with zipfile.ZipFile(base) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            entries[info.filename] = (z.read(info), info.compress_type == zipfile.ZIP_STORED)
    for spec in argv[3:]:
        path, name = spec.split("=", 1)
        with open(path, "rb") as f:
            entries[name] = (f.read(), False)
    if "resources.arsc" in entries:
        entries["resources.arsc"] = (entries["resources.arsc"][0], True)

    central = []
    with open(out, "wb") as f:
        for name in sorted(entries, key=order_key):
            data, stored = entries[name]
            nb = name.encode("utf-8")
            flags = 0x800 if any(b > 0x7F for b in nb) else 0
            crc = zlib.crc32(data) & 0xFFFFFFFF
            if stored:
                method, payload, version = 0, data, 10
            else:
                c = zlib.compressobj(9, zlib.DEFLATED, -15)
                payload = c.compress(data) + c.flush()
                method, version = 8, 20
            offset = f.tell()
            extra = b""
            if method == 0:
                align = 4096 if name.endswith(".so") else 4
                data_start = offset + 30 + len(nb)
                # minimal 6-byte alignment record: id, size, alignment, then zero padding
                pad = (-(data_start + 6)) % align
                extra = struct.pack("<HHH", ALIGN_EXTRA_ID, 2 + pad, align) + b"\0" * pad
            f.write(struct.pack("<IHHHHHIIIHH", 0x04034B50, version, flags, method, DOS_TIME, DOS_DATE,
                                crc, len(payload), len(data), len(nb), len(extra)))
            f.write(nb)
            f.write(extra)
            assert method != 0 or f.tell() % (4096 if name.endswith(".so") else 4) == 0
            f.write(payload)
            central.append(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, version, flags, method, DOS_TIME,
                                       DOS_DATE, crc, len(payload), len(data), len(nb), 0, 0, 0, 0, 0, offset) + nb)
        cd_start = f.tell()
        for rec in central:
            f.write(rec)
        cd_size = f.tell() - cd_start
        f.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(central), len(central), cd_size, cd_start, 0))
    print("packaged %s: %d entries" % (out, len(central)))


if __name__ == "__main__":
    main(sys.argv)
