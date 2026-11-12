# Memory: review fixes

Inbox for the retro. The reviewer adds one line per fix. The retro turns repeated entries into checks or rules and deletes them from here.

Format: `- YYYY-MM-DD | rule or category | what was wrong`

- 2026-11-09 | tests | testDatabaseUrl, which picks the database the harness drops WITH (FORCE), had no test for the _test suffix, an existing _test name, or a missing DATABASE_URL
