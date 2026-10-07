import com.android.apksig.ApkSigner;
import com.android.apksig.ApkSignerEngine;
import com.android.apksig.ApkVerifier;
import com.android.apksig.DefaultApkSignerEngine;
import com.android.apksig.apk.ApkFormatException;
import com.android.apksig.util.DataSink;
import com.android.apksig.util.DataSource;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.SignatureException;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.TreeMap;

/**
 * Command-line signer/verifier built on com.android.apksig (Maven Central
 * com.android.tools.build:apksig:2.3.0), run with the JDK source launcher:
 *
 *   java [exports] -cp apksig-2.3.0.jar ApkSignTool.java sign   IN.apk OUT.apk KEYSTORE STOREPASS ALIAS [KEYPASS]
 *   java [exports] -cp apksig-2.3.0.jar ApkSignTool.java verify APK
 *
 * where [exports] = --add-exports=java.base/sun.security.{x509,pkcs,util}=ALL-UNNAMED
 * (apksig 2.3.0's v1 verifier parses PKCS#7 with JDK-internal classes).
 *
 * v2 (APK Signature Scheme v2) is produced by apksig's DefaultApkSignerEngine. apksig 2.3.0's
 * own v1 (JAR) signer calls a JDK 8-only internal method (PKCS7.encodeSignedData(OutputStream))
 * and fails on JDK 9+, so the v1 part is generated here, inside a delegating ApkSignerEngine,
 * in the exact format apksig uses: SHA-256 MANIFEST.MF, CERT.SF with "X-Android-APK-Signed: 2"
 * (v2 stripping protection) and a DER PKCS#7 SignedData CERT.RSA (RSA, no signed attributes).
 * ApkSigner keeps STORED entries aligned while it rewrites the APK.
 */
public class ApkSignTool {
    public static void main(String[] args) throws Exception {
        if (args.length >= 6 && args[0].equals("sign")) {
            sign(new File(args[1]), new File(args[2]), new File(args[3]), args[4].toCharArray(), args[5],
                    (args.length > 6 ? args[6] : args[4]).toCharArray());
        } else if (args.length == 2 && args[0].equals("verify")) {
            System.exit(verify(new File(args[1])) ? 0 : 1);
        } else {
            System.err.println("usage: sign IN OUT KEYSTORE STOREPASS ALIAS [KEYPASS] | verify APK");
            System.exit(2);
        }
    }

    // ------------------------------------------------------------------ sign

    static void sign(File in, File out, File ks, char[] storePass, String alias, char[] keyPass) throws Exception {
        KeyStore store = KeyStore.getInstance(isPkcs12(ks) ? "PKCS12" : "JKS");
        try (InputStream is = new FileInputStream(ks)) {
            store.load(is, storePass);
        }
        PrivateKey key = (PrivateKey) store.getKey(alias, keyPass);
        if (key == null) throw new IllegalArgumentException("no private key for alias " + alias);
        if (!"RSA".equals(key.getAlgorithm())) throw new IllegalArgumentException("only RSA keys are supported");
        List<X509Certificate> chain = new ArrayList<>();
        for (Certificate c : store.getCertificateChain(alias)) chain.add((X509Certificate) c);

        DefaultApkSignerEngine v2 = new DefaultApkSignerEngine.Builder(
                Collections.singletonList(new DefaultApkSignerEngine.SignerConfig.Builder("CERT", key, chain).build()),
                24 /* minSdkVersion */)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .build();
        V1Engine engine = new V1Engine(v2, "CERT", key, chain);
        File tmp = new File(out.getPath() + ".tmp");
        tmp.delete();
        new ApkSigner.Builder(engine).setInputApk(in).setOutputApk(tmp).build().sign();
        if (!tmp.renameTo(out)) {
            out.delete();
            if (!tmp.renameTo(out)) throw new IOException("cannot move " + tmp + " to " + out);
        }
        System.out.println("signed " + out + " with v1 (JAR, SHA-256) + v2, key alias " + alias
                + ", " + engine.digests.size() + " entries in MANIFEST.MF");
    }

    static boolean isPkcs12(File f) throws IOException {
        try (InputStream is = new FileInputStream(f)) {
            return is.read() == 0x30; // DER SEQUENCE -> PKCS#12; JKS starts with 0xFEEDFEED
        }
    }

    /** True for files that belong to a v1 signature (never digested, replaced by ours). */
    static boolean isV1SignatureFile(String name) {
        String n = name.toUpperCase(Locale.ROOT);
        if (n.equals("META-INF/MANIFEST.MF")) return true;
        if (!n.startsWith("META-INF/") || n.indexOf('/', 9) >= 0) return false;
        return n.endsWith(".SF") || n.endsWith(".RSA") || n.endsWith(".DSA") || n.endsWith(".EC")
                || n.startsWith("META-INF/SIG-");
    }

    static final class DigestSink implements DataSink {
        final MessageDigest md;
        DigestSink() throws NoSuchAlgorithmException { md = MessageDigest.getInstance("SHA-256"); }
        @Override public void consume(byte[] buf, int off, int len) { md.update(buf, off, len); }
        @Override public void consume(ByteBuffer buf) { md.update(buf); }
    }

    static final class TeeSink implements DataSink {
        final DataSink a, b;
        TeeSink(DataSink a, DataSink b) { this.a = a; this.b = b; }
        @Override public void consume(byte[] buf, int off, int len) throws IOException { a.consume(buf, off, len); b.consume(buf, off, len); }
        @Override public void consume(ByteBuffer buf) throws IOException {
            ByteBuffer dup = buf.duplicate();
            a.consume(buf);
            b.consume(dup);
        }
    }

    /** Wraps apksig's v2 engine and adds a v1 JAR signature over the output entries. */
    static final class V1Engine implements ApkSignerEngine {
        final ApkSignerEngine v2;
        final String signerName;
        final PrivateKey key;
        final List<X509Certificate> chain;
        final TreeMap<String, byte[]> digests = new TreeMap<>();
        boolean v1Emitted;

        V1Engine(ApkSignerEngine v2, String signerName, PrivateKey key, List<X509Certificate> chain) {
            this.v2 = v2;
            this.signerName = signerName;
            this.key = key;
            this.chain = chain;
        }

        @Override
        public void inputApkSigningBlock(DataSource block) throws IOException, ApkFormatException {
            v2.inputApkSigningBlock(block);
        }

        @Override
        public InputJarEntryInstructions inputJarEntry(String name) {
            if (isV1SignatureFile(name)) return new InputJarEntryInstructions(InputJarEntryInstructions.OutputPolicy.SKIP);
            return v2.inputJarEntry(name);
        }

        @Override
        public InspectJarEntryRequest outputJarEntry(final String name) {
            final InspectJarEntryRequest inner = v2.outputJarEntry(name);
            if (isV1SignatureFile(name) || name.endsWith("/")) return inner;
            v1Emitted = false;
            final DigestSink sink;
            try {
                sink = new DigestSink();
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
            final DataSink data = inner == null ? sink : new TeeSink(sink, inner.getDataSink());
            return new InspectJarEntryRequest() {
                @Override public DataSink getDataSink() { return data; }
                @Override public String getEntryName() { return name; }
                @Override public void done() {
                    digests.put(name, sink.md.digest());
                    if (inner != null) inner.done();
                }
            };
        }

        @Override
        public InputJarEntryInstructions.OutputPolicy inputJarEntryRemoved(String name) {
            if (isV1SignatureFile(name)) return InputJarEntryInstructions.OutputPolicy.SKIP;
            return v2.inputJarEntryRemoved(name);
        }

        @Override
        public void outputJarEntryRemoved(String name) {
            digests.remove(name);
            v1Emitted = false;
            v2.outputJarEntryRemoved(name);
        }

        @Override
        public OutputJarSignatureRequest outputJarEntries()
                throws ApkFormatException, NoSuchAlgorithmException, InvalidKeyException, SignatureException {
            OutputJarSignatureRequest inner = v2.outputJarEntries();
            if (inner != null) throw new IllegalStateException("inner engine unexpectedly produced v1 entries");
            if (v1Emitted) return null;
            final List<OutputJarSignatureRequest.JarEntry> files = buildV1();
            return new OutputJarSignatureRequest() {
                @Override public List<JarEntry> getAdditionalJarEntries() { return files; }
                @Override public void done() { v1Emitted = true; }
            };
        }

        @Override
        public OutputApkSigningBlockRequest outputZipSections(DataSource zipEntries, DataSource zipCentralDirectory,
                DataSource zipEocd) throws IOException, ApkFormatException, NoSuchAlgorithmException,
                InvalidKeyException, SignatureException {
            if (!v1Emitted) throw new IllegalStateException("v1 signature not output");
            return v2.outputZipSections(zipEntries, zipCentralDirectory, zipEocd);
        }

        @Override public void outputDone() { v2.outputDone(); }
        @Override public void close() { v2.close(); }

        List<OutputJarSignatureRequest.JarEntry> buildV1()
                throws NoSuchAlgorithmException, InvalidKeyException, SignatureException {
            String createdBy = "1.0 (Android)";
            ByteArrayOutputStream mf = new ByteArrayOutputStream();
            attr(mf, "Manifest-Version", "1.0");
            attr(mf, "Created-By", createdBy);
            crlf(mf);
            TreeMap<String, byte[]> sections = new TreeMap<>();
            for (java.util.Map.Entry<String, byte[]> e : digests.entrySet()) {
                ByteArrayOutputStream sec = new ByteArrayOutputStream();
                attr(sec, "Name", e.getKey());
                attr(sec, "SHA-256-Digest", Base64.getEncoder().encodeToString(e.getValue()));
                crlf(sec);
                byte[] s = sec.toByteArray();
                sections.put(e.getKey(), s);
                mf.write(s, 0, s.length);
            }
            byte[] manifest = mf.toByteArray();

            ByteArrayOutputStream sf = new ByteArrayOutputStream();
            attr(sf, "Signature-Version", "1.0");
            attr(sf, "Created-By", createdBy);
            attr(sf, "SHA-256-Digest-Manifest", b64(sha256(manifest)));
            attr(sf, "X-Android-APK-Signed", "2");
            crlf(sf);
            for (java.util.Map.Entry<String, byte[]> e : sections.entrySet()) {
                attr(sf, "Name", e.getKey());
                attr(sf, "SHA-256-Digest", b64(sha256(e.getValue())));
                crlf(sf);
            }
            byte[] sfBytes = sf.toByteArray();

            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initSign(key);
            sig.update(sfBytes);
            byte[] block = pkcs7SignedData(sig.sign(), chain);

            List<OutputJarSignatureRequest.JarEntry> out = new ArrayList<>();
            out.add(new OutputJarSignatureRequest.JarEntry("META-INF/MANIFEST.MF", manifest));
            out.add(new OutputJarSignatureRequest.JarEntry("META-INF/" + signerName + ".SF", sfBytes));
            out.add(new OutputJarSignatureRequest.JarEntry("META-INF/" + signerName + ".RSA", block));
            return out;
        }
    }

    // ------------------------------------------------- JAR manifest helpers

    static void crlf(ByteArrayOutputStream o) { o.write('\r'); o.write('\n'); }

    /** "Name: value" with JAR-spec line wrapping (max 72 bytes per line incl. CRLF). */
    static void attr(ByteArrayOutputStream o, String name, String value) {
        byte[] line = (name + ": " + value).getBytes(StandardCharsets.UTF_8);
        int pos = 0, max = 70;
        while (true) {
            int n = Math.min(max, line.length - pos);
            o.write(line, pos, n);
            crlf(o);
            pos += n;
            if (pos >= line.length) break;
            o.write(' ');
            max = 69;
        }
    }

    static byte[] sha256(byte[] b) throws NoSuchAlgorithmException { return MessageDigest.getInstance("SHA-256").digest(b); }
    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    // ----------------------------------------------------- minimal DER / PKCS#7

    static byte[] der(int tag, byte[]... parts) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] p : parts) body.write(p, 0, p.length);
        int len = body.size();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        if (len < 0x80) {
            o.write(len);
        } else {
            int bytes = len > 0xFFFFFF ? 4 : len > 0xFFFF ? 3 : len > 0xFF ? 2 : 1;
            o.write(0x80 | bytes);
            for (int i = bytes - 1; i >= 0; i--) o.write((len >>> (8 * i)) & 0xFF);
        }
        byte[] b = body.toByteArray();
        o.write(b, 0, b.length);
        return o.toByteArray();
    }

    static byte[] oid(String dotted) {
        String[] arcs = dotted.split("\\.");
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        long first = Long.parseLong(arcs[0]) * 40 + Long.parseLong(arcs[1]);
        base128(o, first);
        for (int i = 2; i < arcs.length; i++) base128(o, Long.parseLong(arcs[i]));
        return der(0x06, o.toByteArray());
    }

    static void base128(ByteArrayOutputStream o, long v) {
        int n = 0;
        long t = v;
        do { n++; t >>>= 7; } while (t != 0);
        for (int i = n - 1; i >= 0; i--) o.write((int) ((v >>> (7 * i)) & 0x7F) | (i > 0 ? 0x80 : 0));
    }

    static final byte[] NULL = {0x05, 0x00};
    static final byte[] INT_1 = {0x02, 0x01, 0x01};

    /** ContentInfo(signedData) with a detached signature, exactly one RSA signer, no signed attributes. */
    static byte[] pkcs7SignedData(byte[] signature, List<X509Certificate> chain) {
        try {
            X509Certificate signer = chain.get(0);
            byte[] sha256Alg = der(0x30, oid("2.16.840.1.101.3.4.2.1"), NULL);
            byte[] rsaAlg = der(0x30, oid("1.2.840.113549.1.1.1"), NULL);
            ByteArrayOutputStream certs = new ByteArrayOutputStream();
            for (X509Certificate c : chain) certs.write(c.getEncoded());
            byte[] signerInfo = der(0x30,
                    INT_1,
                    der(0x30, signer.getIssuerX500Principal().getEncoded(), der(0x02, signer.getSerialNumber().toByteArray())),
                    sha256Alg,
                    rsaAlg,
                    der(0x04, signature));
            byte[] signedData = der(0x30,
                    INT_1,
                    der(0x31, sha256Alg),
                    der(0x30, oid("1.2.840.113549.1.7.1")),
                    der(0xA0, certs.toByteArray()),
                    der(0x31, signerInfo));
            return der(0x30, oid("1.2.840.113549.1.7.2"), der(0xA0, signedData));
        } catch (Exception e) {
            throw new IllegalStateException("cannot encode PKCS#7", e);
        }
    }

    // ---------------------------------------------------------------- verify

    /**
     * Two passes: (1) what Android 7.0+ checks for this minSdk 24 APK (v2; apksig skips v1 there),
     * (2) the v1 JAR signature forced on as well, by also checking platforms 18-23.
     */
    static boolean verify(File apk) throws Exception {
        System.out.println("apksig ApkVerifier (com.android.tools.build:apksig:2.3.0): " + apk);
        System.out.println("[pass 1] platforms = APK minSdkVersion .. latest (default)");
        ApkVerifier.Result r1 = new ApkVerifier.Builder(apk).build().verify();
        int problems = report(r1);
        System.out.println("[pass 2] platforms = 18 .. latest (forces v1 JAR signature verification too)");
        ApkVerifier.Result r2 = new ApkVerifier.Builder(apk).setMinCheckedPlatformVersion(18).build().verify();
        problems += report(r2);
        boolean ok = r1.isVerified() && r1.isVerifiedUsingV2Scheme() && r2.isVerified()
                && r2.isVerifiedUsingV1Scheme() && r2.isVerifiedUsingV2Scheme() && problems == 0;
        System.out.println("VERIFY RESULT: " + (ok ? "OK (v1 + v2 verified, 0 errors, 0 warnings)" : "FAILED"));
        return ok;
    }

    static int report(ApkVerifier.Result r) throws Exception {
        System.out.println("  verified:            " + r.isVerified());
        System.out.println("  verified using v1:   " + r.isVerifiedUsingV1Scheme());
        System.out.println("  verified using v2:   " + r.isVerifiedUsingV2Scheme());
        for (X509Certificate c : r.getSignerCertificates()) {
            System.out.println("  signer:              " + c.getSubjectX500Principal());
            System.out.println("  cert SHA-256:        " + hex(MessageDigest.getInstance("SHA-256").digest(c.getEncoded())));
            System.out.println("  key/cert:            " + c.getPublicKey().getAlgorithm() + " "
                    + ((java.security.interfaces.RSAPublicKey) c.getPublicKey()).getModulus().bitLength() + "-bit, "
                    + c.getSigAlgName() + ", valid until " + c.getNotAfter());
        }
        int warnings = 0, errors = 0;
        for (ApkVerifier.IssueWithParams i : r.getErrors()) { System.out.println("  ERROR:   " + i); errors++; }
        for (ApkVerifier.IssueWithParams i : r.getWarnings()) { System.out.println("  WARNING: " + i); warnings++; }
        for (ApkVerifier.Result.V1SchemeSignerInfo s : r.getV1SchemeSigners()) {
            System.out.println("  v1 signer " + s.getName() + " (" + s.getSignatureFileName() + ", " + s.getSignatureBlockFileName() + ")");
            for (ApkVerifier.IssueWithParams i : s.getErrors()) { System.out.println("    ERROR:   " + i); errors++; }
            for (ApkVerifier.IssueWithParams i : s.getWarnings()) { System.out.println("    WARNING: " + i); warnings++; }
        }
        for (ApkVerifier.Result.V1SchemeSignerInfo s : r.getV1SchemeIgnoredSigners()) {
            System.out.println("  v1 ignored signer " + s.getName());
        }
        for (ApkVerifier.Result.V2SchemeSignerInfo s : r.getV2SchemeSigners()) {
            System.out.println("  v2 signer #" + s.getIndex());
            for (ApkVerifier.IssueWithParams i : s.getErrors()) { System.out.println("    ERROR:   " + i); errors++; }
            for (ApkVerifier.IssueWithParams i : s.getWarnings()) { System.out.println("    WARNING: " + i); warnings++; }
        }
        System.out.println("  errors: " + errors + ", warnings: " + warnings);
        return errors + warnings;
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
