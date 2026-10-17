# Restricted ADT path formatter

This project-owned implementation replaces the `sprintf-js` dependency of the
pinned `abap-adt-api` package through an npm override. It supports only `%s` string
substitution and `%%` literal percent signs. It is not a general sprintf library.
Numeric precision, padding, named arguments, and other directives are rejected.
Formats and arguments are bounded, and arguments are never reparsed as formats.

The ADT library currently calls `sprintf` only in its object-creation path builder.
`tests/dependency-security.test.ts` verifies every registered creation path and the
actual library integration. Review these assumptions when upgrading that library.
Windows staging copies `vendor/` before installing production dependencies, using
`--install-links` to install ordinary files instead of runtime symlinks.
