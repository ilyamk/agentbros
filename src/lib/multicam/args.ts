/** Splits `--name a b c` (values up to the next flag) out of argv; `--name=a,b` also works. */
export function takeList(argv: string[], name: string): { values: string[] | undefined; rest: string[] } {
  const rest: string[] = [];
  let values: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith(`--${name}=`)) {
      values = [
        ...(values ?? []),
        ...token
          .slice(name.length + 3)
          .split(",")
          .filter(Boolean),
      ];
    } else if (token === `--${name}`) {
      values ??= [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) values.push(argv[++i]!);
    } else rest.push(token);
  }
  return { values, rest };
}
