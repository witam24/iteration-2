/* Runs student Python code with Pyodide (CPython compiled to WebAssembly).
   Each test feeds its inputs to input(); the prompt and the value are echoed so the
   output can be compared with the worksheet's sample runs. */
const BASE = new URL('./', self.location.href).href;
importScripts(BASE + 'pyodide.js');
const RUNNER = `
import sys, io, json
class _Limit(Exception): pass
class _NoInput(Exception): pass
def _run_one(src, inputs, post='', limit=400000):
    out = io.StringIO()
    feed = list(inputs); pos = [0]; count = [0]
    def _input(prompt=''):
        out.write(str(prompt))
        if pos[0] >= len(feed):
            raise _NoInput()
        v = feed[pos[0]]; pos[0] += 1
        out.write(v + '\\n')
        return v
    def _trace(frame, event, arg):
        if frame.f_code.co_filename != '<code>':
            return None
        if event == 'line':
            count[0] += 1
            if count[0] > limit:
                raise _Limit()
        return _trace
    g = {'__name__': '__main__', 'input': _input}
    kind = 'ok'; err = ''; line = 0
    old = sys.stdout; sys.stdout = out
    try:
        code = compile(src, '<code>', 'exec')
        sys.settrace(_trace)
        exec(code, g)
    except _Limit:
        kind = 'timeout'
    except _NoInput:
        kind = 'noinput'
    except SyntaxError as e:
        kind = 'syntax'; err = str(e.msg); line = e.lineno or 0
    except BaseException as e:
        kind = 'error'; err = type(e).__name__ + (': ' + str(e) if str(e) else '')
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == '<code>':
                line = tb.tb_lineno
            tb = tb.tb_next
    finally:
        sys.settrace(None); sys.stdout = old
    post_out = ''
    if post and kind == 'ok':
        buf = io.StringIO(); sys.stdout = buf
        try:
            exec(post, g)
        except BaseException:
            pass
        finally:
            sys.stdout = old
        post_out = buf.getvalue()
    return {'out': out.getvalue(), 'kind': kind, 'err': err, 'line': line, 'unused': len(feed) - pos[0], 'post': post_out}
def _trace(src, inputs, max_steps=1500):
    """Record one frame per executed line: the line number and the program's variables just before it runs."""
    out = io.StringIO()
    feed = list(inputs); pos = [0]
    frames = []
    def _input(prompt=''):
        out.write(str(prompt))
        if pos[0] >= len(feed):
            raise _NoInput()
        v = feed[pos[0]]; pos[0] += 1
        out.write(v + '\\n')
        return v
    g = {'__name__': '__main__', 'input': _input}
    def snap(f):
        d = {}
        for k, v in list(f.f_globals.items()) + (list(f.f_locals.items()) if f.f_locals is not f.f_globals else []):
            if k.startswith('_') or k == 'input' or callable(v) or type(v).__name__ == 'module':
                continue
            try:
                d[k] = repr(v)
            except Exception:
                d[k] = '?'
        return d
    def _tr(frame, event, arg):
        if frame.f_code.co_filename != '<code>':
            return None
        if event == 'line':
            frames.append({'line': frame.f_lineno, 'vars': snap(frame), 'out': len(out.getvalue())})
            if len(frames) > max_steps:
                raise _Limit()
        return _tr
    kind = 'ok'; err = ''; line = 0
    old = sys.stdout; sys.stdout = out
    try:
        code = compile(src, '<code>', 'exec')
        sys.settrace(_tr)
        exec(code, g)
    except _Limit:
        kind = 'timeout'
    except _NoInput:
        kind = 'noinput'
    except SyntaxError as e:
        kind = 'syntax'; err = str(e.msg); line = e.lineno or 0
    except BaseException as e:
        kind = 'error'; err = type(e).__name__ + (': ' + str(e) if str(e) else '')
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == '<code>':
                line = tb.tb_lineno
            tb = tb.tb_next
    finally:
        sys.settrace(None); sys.stdout = old
    end = {}
    for k, v in g.items():
        if k.startswith('_') or k == 'input' or callable(v) or type(v).__name__ == 'module':
            continue
        try:
            end[k] = repr(v)
        except Exception:
            end[k] = '?'
    frames.append({'line': 0, 'vars': end, 'out': len(out.getvalue()), 'end': True})
    if len(frames) > max_steps + 1:
        frames = frames[:max_steps] + [frames[-1]]
    return json.dumps({'frames': frames, 'out': out.getvalue(), 'kind': kind, 'err': err, 'line': line}, ensure_ascii=False)
def _run_all(src, tests_json, post):
    return json.dumps([_run_one(src, t, post) for t in json.loads(tests_json)], ensure_ascii=False)
`;
let py = null;
const ready = (async () => {
  // the standard library is published as base64 text (archives are not served), then handed to Pyodide as a blob
  const b64 = await (await fetch(BASE + 'python_stdlib.b64.txt')).text();
  const bin = Uint8Array.from(atob(b64.trim()), c => c.charCodeAt(0));
  const stdLibURL = URL.createObjectURL(new Blob([bin], { type: 'application/zip' }));
  py = await loadPyodide({ indexURL: BASE, stdLibURL });
  py.runPython(RUNNER);
})();
self.onmessage = async e => {
  const { id, code, tests, post } = e.data;
  try {
    await ready;
    if (id === 'init') { self.postMessage({ id, ready: true }); return; }
    if (e.data.mode === 'trace') { py.globals.set('_SRC', code); py.globals.set('_TESTS', JSON.stringify(tests)); self.postMessage({ id, trace: JSON.parse(py.runPython('_trace(_SRC, json.loads(_TESTS))')) }); return; }
    py.globals.set('_SRC', code); py.globals.set('_TESTS', JSON.stringify(tests)); py.globals.set('_POST', post || '');
    const res = JSON.parse(py.runPython('_run_all(_SRC, _TESTS, _POST)'));
    self.postMessage({ id, res });
  } catch (err) {
    self.postMessage({ id, fail: String(err && err.message || err) });
  }
};
