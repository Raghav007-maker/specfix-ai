import { assignableRoles, canManageMember, type MemberRow, type Role } from '@/lib/repos';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  RoleBadge,
  Select,
} from '@/components/ui';
import { addMemberAction, changeRoleAction, removeMemberAction } from './actions';

const ROLE_INFO: Record<Role, { title: string; summary: string; can: string[] }> = {
  owner: {
    title: 'Owner',
    summary: 'Runs the workspace.',
    can: ['Everything an admin can do', 'Grant or revoke the owner role', 'Manage other owners'],
  },
  admin: {
    title: 'Admin',
    summary: 'Organisation admin: manages people, projects and analysis.',
    can: ['Add and remove admins and reviewers', 'Change their roles', 'Create projects'],
  },
  reviewer: {
    title: 'Reviewer',
    summary: 'Product manager / reviewer: does the review work.',
    can: [
      'Blind-first gap lists',
      'Accept, edit and dismiss flags',
      'Review scenarios and scaffolds',
    ],
  },
};

export function RoleCard({ role, count, mine }: { role: Role; count: number; mine: boolean }) {
  const info = ROLE_INFO[role];
  return (
    <Card className={mine ? 'ring-2 ring-primary/30' : undefined}>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <RoleBadge role={role} />
          <span className="text-xs text-muted-foreground">
            {count} {count === 1 ? 'member' : 'members'}
            {mine ? ' · your role' : ''}
          </span>
        </div>
        <div>
          <p className="font-semibold">{info.title}</p>
          <p className="text-sm text-muted-foreground">{info.summary}</p>
        </div>
        <ul className="space-y-1 text-sm">
          {info.can.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-positive">
                ✓
              </span>
              {line}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function MemberItem({
  member,
  self,
  myRole,
}: {
  member: MemberRow;
  self: boolean;
  myRole: Role;
}) {
  const editable = !self && canManageMember(myRole, member.role);
  const options = assignableRoles(myRole);
  const email = member.email ?? 'unknown user';

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold uppercase text-primary"
        >
          {email.charAt(0)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium">
            {email}
            {self ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">Joined {joined(member.created_at)}</p>
        </div>
      </div>

      {editable ? (
        <div className="flex items-center gap-2">
          <form action={changeRoleAction} className="flex items-center gap-2">
            <input type="hidden" name="userId" value={member.user_id} />
            <input type="hidden" name="email" value={email} />
            <Select
              name="role"
              defaultValue={member.role}
              aria-label={`Role for ${email}`}
              className="h-8 text-xs"
            >
              {options.map((role) => (
                <option key={role} value={role}>
                  {ROLE_INFO[role].title}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" variant="outline">
              Save
            </Button>
          </form>
          <form action={removeMemberAction}>
            <input type="hidden" name="userId" value={member.user_id} />
            <input type="hidden" name="email" value={email} />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Remove
            </Button>
          </form>
        </div>
      ) : (
        <RoleBadge role={member.role} />
      )}
    </li>
  );
}

export function AddMember({ roles }: { roles: Role[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a member</CardTitle>
        <p className="text-sm text-muted-foreground">
          They need a SpecFix account first — ask them to sign up, then add their email here.
        </p>
      </CardHeader>
      <CardContent>
        <form action={addMemberAction} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              name="email"
              type="email"
              required
              placeholder="name@company.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-role">Role</Label>
            <Select id="member-role" name="role" defaultValue="reviewer" className="w-full">
              {roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_INFO[role].title}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" className="w-full">
            Add member
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function RoleRules() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rules</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
          <li>Admins manage admins and reviewers, never owners.</li>
          <li>Only an owner can make someone an owner.</li>
          <li>No one can change their own role or remove themselves.</li>
          <li>A workspace always keeps at least one owner.</li>
        </ul>
      </CardContent>
    </Card>
  );
}

function joined(value: Date | string): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
