# Phase 6 GUI Encryption Evidence

Date: 2026-08-13

## Tool verification

- Installed 7-Zip 26.02 x64 from the official `ip7z/7zip` GitHub release linked by 7-zip.org.
- Downloaded installer SHA-256: `6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0`.
- The digest matched the publisher's GitHub release-asset metadata before installation.

## Disposable GUI drill

- Created a temporary plaintext package containing a unique canary.
- Encrypted it manually in the 7-Zip GUI using the 7z format, AES-256, and encrypted filenames.
- Extracted it manually into a separate temporary directory without disclosing or persisting the password.
- Encrypted canary archive SHA-256: `d31e835b9af66585a8eea6a1eb19eb90a9d56f3fa6502be79cdea7fc2111a35a`.
- A deliberately wrong password could not list the archive filenames, proving header protection was enabled.
- Extracted `CANARY.txt` matched `JARVIS_PHASE6_GUI_CANARY_OK` exactly.
- The temporary plaintext, encrypted, and decrypted fixtures were removed after verification.

This proves the approved manual GUI encryption/decryption boundary. It does not claim that a real company node has been enrolled, evicted, restored, remotely revoked, or erased.
