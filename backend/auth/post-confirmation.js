/* ============================================================
   KCMPS backend — post-confirmation Lambda
   ============================================================
   Trigger: Cognito User Pool "Post confirmation" Lambda trigger, fired
   once per successful sign-up confirmation (event.triggerSource ===
   "PostConfirmation_ConfirmSignUp"; also fires for admin-confirmed and
   forgot-password-reset flows, filtered out below since the user in
   those cases already exists/has groups).

   Job: add the new user to the Customer group. Nothing in
   backend/lib/auth.js actually requires Customer group membership today
   (isStaff() is the real gate; "not staff" already reads as customer
   everywhere) — this exists so the group reserved in
   backend/infra/foundation.cfn.yaml stops being permanently empty, and
   so a future feature that *does* check for it doesn't silently break
   for every organic signup. See docs/roadmap.md and docs/history.md for
   the full writeup.

   Cognito-specific trap, why this never throws: a PostConfirmation
   trigger that returns an error fails the client's ConfirmSignUp call
   even though the user is already confirmed server-side by the time
   this runs — a confusing false failure for someone who just signed up
   successfully. So every failure path here logs and returns the event
   unchanged rather than throwing; a missed group-add is recoverable
   (admin-add-user-to-group later), a bricked signup flow is not.
   ============================================================ */

const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ROLES } = require("../lib");

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;

  try {
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      GroupName: ROLES.CUSTOMER,
    }));
  } catch (err) {
    console.error("post-confirmation: failed to add user to Customer group", {
      userPoolId: event.userPoolId, userName: event.userName, error: err && err.message,
    });
  }

  return event;
};
