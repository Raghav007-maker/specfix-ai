# SpecFix ↔ GitHub integration demo

This PR exists to demonstrate the SpecFix GitHub App end to end:

- it is linked to **CART-1** (branch name and title) and **CART-2** (this description);
- SpecFix comments once while a linked ticket is not "Ready for development", and edits that
  same comment when the tickets are signed off;
- once CI posts a Playwright report for this commit, the "SpecFix acceptance" check shows
  how many of the approved acceptance scenarios pass.
