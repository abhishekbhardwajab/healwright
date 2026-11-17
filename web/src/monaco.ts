// Bundle Monaco locally (no CDN) so the code panel works offline and behind proxies.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};
loader.config({ monaco });
