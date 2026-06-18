import type { Role, SessionUser, User } from "../shared/contracts.ts";

export function toSessionUser(
  user: Pick<User, "id" | "email" | "name">,
  roles: Role[] = [],
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles,
  };
}
