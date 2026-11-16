/** A request the users service refuses. The message is English: it's shown to operators, not in the UI. */
export class UserInputError extends Error {
  override name = 'UserInputError';
}
