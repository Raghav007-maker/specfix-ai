# ONB-73 SAML SSO for enterprise accounts

## Description

Two deals are blocked on SSO. Enterprise workspace owners should be able to
configure a SAML identity provider and require their members to sign in through it.

Once SSO is enforced, members authenticate through the IdP. Members should still be
able to sign in with their existing email and password so nobody gets locked out
during the rollout.

Owners need to be able to see who has signed in via SSO.

## Acceptance Criteria

- Workspace owner can enter IdP metadata
- Owner can toggle "require SSO for all members"
- Members are redirected to the IdP on sign-in
- Members can sign in with email and password
- Sign-in method is visible to the owner
