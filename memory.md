# Memory: review fixes

Inbox for the retro. The reviewer adds one line per fix. The retro turns repeated entries into checks or rules and deletes them from here.

Format: `- YYYY-MM-DD | rule or category | what was wrong`

- 2026-11-09 | tests | testDatabaseUrl, which picks the database the harness drops WITH (FORCE), had no test for the _test suffix, an existing _test name, or a missing DATABASE_URL
- 2026-11-14 | tests | the tampered-token test changed the last base64url characters of the signature, whose padding bits decoding ignores, so about 1 run in 900 it sent the valid token and failed
- 2026-11-14 | tests | the HS256 pin in session verification had no test: the alg none test passes without it, because jose never accepts none
- 2026-11-14 | tests | UsersService's refuses-invalid-input table counted rows for an email the invalid-email cases never sent, so their writes-nothing check always passed
- 2026-11-17 | D2 | the delete audit test read before->>'deleted_at' as null, which a missing before snapshot also gives, so a delete entry without its before row passed
- 2026-11-17 | tests | nothing in the invariant 7 tests said documents without a number never collide; dropping the index's number_normalized IS NOT NULL only failed balances.spec, whose fixtures happened to give one supplier two numberless documents
