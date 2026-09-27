// What each observer is, as data with no dependencies: the action catalogue,
// the argument schema and the completion gate read it, the implementations in
// observe.ts use it. Adding an observer adds an entry here and one there; the
// loop and the gate do not change.
export interface ObserverDescription { kind: string; what: string; question: string }
export const observerCatalog: ObserverDescription[] = [
  { kind: 'page',
    what: 'a page loaded in a headless browser: exceptions, failed requests and images, console messages, how it is styled, overflow, headings, links and text',
    question: 'Judged only by this render evidence, does the page look finished to the user the objective describes: styled and laid out as intended, its content present, nothing broken?' },
  { kind: 'http',
    what: 'a running service answering one HTTP GET: the status, content type, size, and the body (with the keys of a JSON body)',
    question: 'Judged only by this response, does the service answer as the objective requires: the right status, the expected content, nothing broken?' },
  { kind: 'program',
    what: 'a program run from the shell as its user would run it: the exit code and what it printed',
    question: 'Judged only by this run, does the program behave as the objective requires for its user: the expected output, no errors?' },
];
export const observerKinds = observerCatalog.map(o => o.kind);
export const describeObserver = (kind: string): ObserverDescription | undefined => observerCatalog.find(o => o.kind === kind);
