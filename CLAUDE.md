# Notes for Claude

- This repo is the Property Potential content agent. It must stay separate from `property-potential-app`: never modify, commit to, push to or deploy that app from here.
- Photos: only photos the owner has rights to (`owned` / `permission`). Do not add code that downloads listing photos or scrapes Rightmove, Zoopla or similar portals.
- No automatic publishing or property discovery until krish asks for it.
- Run `npm run typecheck` and `npm test` before pushing. `npm run pp-content -- new examples/sample/brief.yaml --mock` renders a full offline Reel (about 2 minutes).
- The claim gate (`src/pipeline/script.ts` `checkScript`) and fact verification (`src/pipeline/facts.ts` `verifyFacts`) are the safety core; change them with tests.
