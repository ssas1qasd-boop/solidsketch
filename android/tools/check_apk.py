#!/usr/bin/env python3
"""Structural checks for the built APK (no Android SDK needed).

  * every STORED entry's data offset is 4-byte aligned (4096 for .so), parsed from the
    local file headers the central directory points to
  * resources.arsc exists and is STORED
  * classes.dex: magic/version, Adler-32 checksum, SHA-1 signature, file size, and the list
    of class definitions (the activity class must be present)
  * APK Signing Block present (v2 signature) before the central directory

Usage: python3 -I check_apk.py APP.apk [com.solidsketch.app.MainActivity]
Exit code 0 when every check passes.
"""
import hashlib
import struct
import sys
import zipfile
import zlib


def uleb128(buf, off):
    result = shift = 0
    while True:
        b = buf[off]
        off += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, off
        shift += 7


def dex_classes(dex):
    string_ids_size, string_ids_off, type_ids_size, type_ids_off = struct.unpack_from("<IIII", dex, 0x38)
    class_defs_size, class_defs_off = struct.unpack_from("<II", dex, 0x60)

    def string(i):
        data_off = struct.unpack_from("<I", dex, string_ids_off + 4 * i)[0]
        _, p = uleb128(dex, data_off)
        end = dex.index(b"\0", p)
        return dex[p:end].decode("utf-8", "replace")

    out = []
    for k in range(class_defs_size):
        class_idx = struct.unpack_from("<I", dex, class_defs_off + 32 * k)[0]
        desc_idx = struct.unpack_from("<I", dex, type_ids_off + 4 * class_idx)[0]
        out.append(string(desc_idx))
    return out, string_ids_size, type_ids_size, class_defs_size


def main(argv):
    apk = argv[1]
    want = argv[2] if len(argv) > 2 else "com.solidsketch.app.MainActivity"
    ok = True
    raw = open(apk, "rb").read()
    print("== alignment / compression (%s)" % apk)
    with zipfile.ZipFile(apk) as z:
        infos = z.infolist()
        stored = 0
        for info in infos:
            lh = info.header_offset
            sig, = struct.unpack_from("<I", raw, lh)
            assert sig == 0x04034B50, "bad local header for " + info.filename
            nlen, xlen = struct.unpack_from("<HH", raw, lh + 26)
            data_off = lh + 30 + nlen + xlen
            if info.compress_type == zipfile.ZIP_STORED:
                stored += 1
                align = 4096 if info.filename.endswith(".so") else 4
                good = data_off % align == 0
                ok &= good
                print("  STORED   %-45s data@%-9d %% %d = %d  %s" % (info.filename, data_off, align, data_off % align,
                                                                   "OK" if good else "MISALIGNED"))
            else:
                print("  DEFLATED %-45s data@%d" % (info.filename, data_off))
        names = {i.filename: i for i in infos}
        arsc = names.get("resources.arsc")
        arsc_ok = arsc is not None and arsc.compress_type == zipfile.ZIP_STORED
        ok &= arsc_ok
        print("  resources.arsc present and STORED: %s" % arsc_ok)
        print("  %d entries, %d stored, all stored entries aligned: %s" % (len(infos), stored, ok))
        bad = z.testzip()
        print("  CRC check of all entries: %s" % ("OK" if bad is None else "FAILED at " + bad))
        ok &= bad is None

        print("== classes.dex")
        dex = z.read("classes.dex")
        magic = dex[:8]
        print("  magic: %r" % magic)
        magic_ok = magic[:4] == b"dex\n" and magic[4:7] in (b"035", b"037", b"038", b"039") and magic[7] == 0
        checksum, = struct.unpack_from("<I", dex, 8)
        adler_ok = checksum == (zlib.adler32(dex[12:]) & 0xFFFFFFFF)
        sha_ok = dex[12:32] == hashlib.sha1(dex[32:]).digest()
        size_ok = struct.unpack_from("<I", dex, 32)[0] == len(dex)
        endian_ok = struct.unpack_from("<I", dex, 40)[0] == 0x12345678
        print("  version %s, size %d, adler32 %s, sha1 %s, file_size field %s, endian tag %s" % (
            magic[4:7].decode(), len(dex), "OK" if adler_ok else "BAD", "OK" if sha_ok else "BAD",
            "OK" if size_ok else "BAD", "OK" if endian_ok else "BAD"))
        classes, ns, nt, nc = dex_classes(dex)
        print("  %d strings, %d types, %d class defs:" % (ns, nt, nc))
        for c in classes:
            print("    " + c)
        desc = "L" + want.replace(".", "/") + ";"
        has = desc in classes
        print("  %s defined: %s" % (desc, has))
        ok &= magic_ok and adler_ok and sha_ok and size_ok and endian_ok and has

    print("== APK Signing Block")
    eocd = raw.rfind(b"PK\x05\x06")
    cd_off, = struct.unpack_from("<I", raw, eocd + 16)
    block_ok = raw[cd_off - 16:cd_off] == b"APK Sig Block 42"
    if block_ok:
        size, = struct.unpack_from("<Q", raw, cd_off - 24)
        start = cd_off - size - 8
        p = start + 8
        ids = []
        while p < cd_off - 24:
            ln, pid = struct.unpack_from("<QI", raw, p)
            ids.append(hex(pid))
            p += 8 + ln
        print("  present (%d bytes) before central directory @%d, pair ids: %s  (0x7109871a = v2)" % (size + 8, cd_off, ", ".join(ids)))
        block_ok = "0x7109871a" in ids
    else:
        print("  missing")
    ok &= block_ok
    print("== RESULT: %s" % ("ALL CHECKS PASSED" if ok else "CHECKS FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
