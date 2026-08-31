# Live checks

`tests/db.test.mjs` runs offline against fixtures. Fixtures cannot catch a
malformed PostgREST embed, so the `select=` strings in `lib/db.mjs` were
validated against the live REST endpoint by hand.

That check found a real defect worth recording: `materials -> locations` is
**ambiguous** to PostgREST, because there are two relationships between those
tables — the `source_id` foreign key (which quarry produced the material) and a
many-to-many through `location_materials` (which plants stock it). The
unqualified embed returns `PGRST201` and no rows. Every such embed must name the
constraint:

```
source:locations!materials_source_id_fkey(id,name,code)
```

To re-validate after changing a `select=`, issue the query against
`$SUPABASE_URL/rest/v1/...` with any key. A malformed embed returns 400/300 with
a `PGRST*` code; a well-formed one returns 200. Row counts will be 0 with a
publishable key because RLS is enabled on every QC table with no anon read
policy — that is expected and does not affect the syntax check.

Do not add a live test to `npm test`: it would need the service-role key, and
that key belongs only in the Netlify environment.
