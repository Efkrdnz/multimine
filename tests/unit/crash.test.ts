import { describe, expect, it } from 'vitest'
import { compactTrace, crashPrompt, exitProblem, findProblems } from '@shared/run/crash'

const lines = (s: string) => s.replace(/^\n/, '').split('\n')

describe('finding problems in a game run', () => {
  it('reads a Java stack trace behind Minecraft log prefixes, with its cause and source paths', () => {
    const out = lines(`
[12:00:01] [Render thread/INFO] (Minecraft) Loading world
[12:00:02] [Render thread/ERROR] (Minecraft) Exception ticking spell
java.lang.NullPointerException: Cannot invoke "Entity.getPos()" because "this.target" is null
\tat com.mana.spells.Fireball.cast(Fireball.java:42)
\tat com.mana.spells.SpellManager$Queue.tick(SpellManager.java:118)
\tat TRANSFORMER/minecraft@1.20.1/net.minecraft.client.Minecraft.tick(Minecraft.java:1800)
\tat java.base/java.lang.Thread.run(Thread.java:833)
Caused by: java.lang.IllegalStateException: target lost
\tat com.mana.spells.Targeting.find(Targeting.kt:9)
\t... 3 more
[12:00:03] [Render thread/INFO] (Minecraft) Saving`)
    const { problems, settled } = findProblems(out)
    expect(settled).toBe(out.length)
    expect(problems).toHaveLength(1)
    const p = problems[0]
    expect(p).toMatchObject({ kind: 'java', fatal: false, cause: 'java.lang.IllegalStateException: target lost' })
    expect(p.title).toBe('java.lang.NullPointerException: Cannot invoke "Entity.getPos()" because "this.target" is null')
    expect(p.frames.slice(0, 2)).toEqual([
      { file: 'Fireball.java', line: 42, symbol: 'com.mana.spells.Fireball.cast', hint: 'com/mana/spells/Fireball.java' },
      { file: 'SpellManager.java', line: 118, symbol: 'com.mana.spells.SpellManager$Queue.tick', hint: 'com/mana/spells/SpellManager.java' }
    ])
    expect(p.frames.find((f) => f.file === 'Targeting.kt')?.hint).toBe('com/mana/spells/Targeting.kt')
    expect(p.trace.at(-1)).toBe('\t... 3 more')
  })

  it('reads a Minecraft crash report as one fatal crash, with the file it was saved to', () => {
    const out = lines(`
---- Minecraft Crash Report ----
// Who set us up the TNT?

Time: 2026-10-11 12:00:00
Description: Ticking entity

java.lang.ArithmeticException: / by zero
\tat com.mana.spells.Bolt.damage(Bolt.java:7)
\tat net.minecraft.world.entity.Entity.tick(Entity.java:500)


A detailed walkthrough of the error, its code path and all known details is as follows:
[12:00:05] [Render thread/FATAL]: #@!@# Game crashed! Crash report saved to: #@!@# C:\\mods\\run\\crash-reports\\crash-2026-10-11.txt`)
    const { problems } = findProblems(out, true)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'minecraft', fatal: true, title: 'Minecraft crashed: Ticking entity', cause: 'java.lang.ArithmeticException: / by zero', reportFile: 'C:\\mods\\run\\crash-reports\\crash-2026-10-11.txt' })
    expect(problems[0].frames[0]).toMatchObject({ file: 'Bolt.java', line: 7 })
  })

  it('reads Godot script errors with their res:// lines', () => {
    const out = lines(`
Godot Engine v4.3.stable
SCRIPT ERROR: Invalid access to property or key 'hp' on a base object of type 'Nil'.
          at: Player._process (res://scripts/player.gd:20)
          GDScript backtrace (most recent call first):
              [0] _process (res://scripts/player.gd:20)
ERROR: Condition "!is_inside_tree()" is true.
   at: get_global_transform (scene/2d/node_2d.cpp:400)
done`)
    const { problems } = findProblems(out, true)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'godot', title: "Invalid access to property or key 'hp' on a base object of type 'Nil'." })
    expect(problems[0].frames[0]).toMatchObject({ file: 'scripts/player.gd', line: 20 })
  })

  it('reads a Python traceback with the innermost frame first', () => {
    const out = lines(`
Traceback (most recent call last):
  File "/game/main.py", line 10, in <module>
    run()
  File "/game/spells.py", line 4, in run
    cast(None)
TypeError: cast() missing target
bye`)
    const [p] = findProblems(out).problems
    expect(p).toMatchObject({ kind: 'python', title: 'TypeError: cast() missing target' })
    expect(p.frames[0]).toEqual({ file: '/game/spells.py', line: 4, symbol: 'run' })
  })

  it('reads JavaScript, Unity and .NET traces, and Rust panics', () => {
    const js = findProblems(lines(`
/app/src/game.js:12
TypeError: Cannot read properties of undefined (reading 'hp')
    at Player.update (/app/src/player.js:30:9)
    at node:internal/main/run_main_module:28:49
    at /app/src/game.js:12:3
Node.js v22`)).problems
    expect(js[0]).toMatchObject({ kind: 'js', title: "TypeError: Cannot read properties of undefined (reading 'hp')" })
    expect(js[0].frames.map((f) => `${f.file}:${f.line}`)).toEqual(['/app/src/player.js:30', '/app/src/game.js:12'])

    const unity = findProblems(lines(`
NullReferenceException: Object reference not set to an instance of an object
Player.Update () (at Assets/Scripts/Player.cs:42)
UnityEngine.Debug:Log (object)
`), true).problems
    expect(unity[0]).toMatchObject({ kind: 'csharp', frames: [{ file: 'Assets/Scripts/Player.cs', line: 42 }] })

    const dotnet = findProblems(lines(`
Unhandled exception. System.InvalidOperationException: Sequence contains no elements
   at Game.Spells.Pick() in C:\\game\\Spells.cs:line 17
   at Game.Program.Main() in C:\\game\\Program.cs:line 5
`), true).problems
    expect(dotnet[0]).toMatchObject({ kind: 'csharp', fatal: true, frames: [{ file: 'C:\\game\\Spells.cs', line: 17 }, { file: 'C:\\game\\Program.cs', line: 5 }] })

    const rust = findProblems(lines(`
thread 'main' panicked at src/spells.rs:10:5:
attempt to divide by zero
note: run with RUST_BACKTRACE=1`), true).problems
    expect(rust[0]).toMatchObject({ kind: 'rust', title: 'panicked: attempt to divide by zero', frames: [{ file: 'src/spells.rs', line: 10 }] })
  })

  it('leaves a trace that may still be printing for the next call', () => {
    const head = lines(`
starting
java.lang.RuntimeException: boom
\tat com.a.B.c(B.java:1)`)
    const first = findProblems(head)
    expect(first).toEqual({ problems: [], settled: 1 })
    const rest = [...head.slice(first.settled), '\tat com.a.B.d(B.java:2)', 'next line']
    const second = findProblems(rest)
    expect(second.problems[0].frames).toHaveLength(2)
    expect(second.settled).toBe(rest.length)
  })

  it('ignores the word Error with no trace after it', () => {
    expect(findProblems(lines(`
Error loading optional texture pack, using defaults
WARN: something
ok`), true).problems).toEqual([])
  })

  it('a run that dies without a trace keeps its last lines', () => {
    const p = exitProblem(1, null, ['', 'Task :runClient FAILED', 'BUILD FAILED in 3s'])
    expect(p).toMatchObject({ kind: 'exit', title: 'Exited with code 1', fatal: true, trace: ['Task :runClient FAILED', 'BUILD FAILED in 3s'] })
  })
})

describe('sending a problem to a chat', () => {
  it('keeps project frames, folds library frames, and includes the code where it broke', () => {
    const trace = ['java.lang.NullPointerException: x', '\tat com.mana.Fireball.cast(Fireball.java:42)', ...Array.from({ length: 30 }, (_, i) => `\tat net.minecraft.A${i}.run(A${i}.java:${i})`), '\tat com.mana.Mod.init(Mod.java:3)']
    const short = compactTrace(trace, (l) => l.includes('Fireball.java') || l.includes('Mod.java'))
    expect(short).toEqual(['java.lang.NullPointerException: x', '\tat com.mana.Fireball.cast(Fireball.java:42)', ...trace.slice(2, 5), '    ... 27 more frames', '\tat com.mana.Mod.init(Mod.java:3)'])

    const [p] = findProblems(trace, true).problems
    p.places = [{ path: 'src/main/java/com/mana/Fireball.java', line: 42, snippet: '  41 |   void cast() {\n> 42 |     target.hurt(5);\n  43 |   }' }]
    const prompt = crashPrompt({ ...p, fatal: true }, { command: './gradlew runClient', code: 1 })
    expect(prompt).toContain('`./gradlew runClient` crashed (exit code 1).')
    expect(prompt).toContain('`src/main/java/com/mana/Fireball.java:42`')
    expect(prompt).toContain('> 42 |     target.hurt(5);')
    expect(prompt).toMatch(/\.\.\. \d+ more frames/)
    expect(prompt.length).toBeLessThan(1600)
  })
})
