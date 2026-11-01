# Native description fixtures

The `native-descriptions/` and `native-descriptions-dag/` directories contain
synthetic output from RePoE commit
`3e1e488ff2763acb692387f4d8fbb69019985cf2`, using its standard-library native CSD
producer. They contain no acquired game rows. Their source vectors are retained
in the neighboring `*-source.json` files as exact BOM UTF-16LE bytes in Base64;
all raw fingerprints match the manifest. These bytes can be replayed through
that producer with the included lock and explicit expected lock digest.

The normal fixture covers source context, ordered multi-ID descriptions,
parameter reordering, repeated/absent language branches, quality restrictions,
handler/sign/literal differences and uninterpreted syntax. Includes and local
suppression retain their source positions. No pairing decision in this
translation consumer generated those source branches.

The DAG fixture has seventeen files, sixteen edges per path, and eight repeated
includes at each non-leaf. It checks bounded graph validation while retaining
all literal records. Neither fixture establishes source authentication, gameplay
semantics, real translation accuracy or runtime readiness. Resealed corruption
tests supply new synthetic external pins; they do not claim to bypass a trusted
real-package pin.
