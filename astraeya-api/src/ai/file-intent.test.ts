import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wantsFileEdit, wantsFileOutput, wantsVectorArt } from "./file-intent";

const ask = (message: string, attachmentTypes: string[] = []) =>
  wantsFileOutput({ message, attachmentTypes });

describe("wantsFileOutput", () => {
  it("recognises requests for documents, slides and spreadsheets", () => {
    assert.equal(ask("Make me a PowerPoint on climate change for my class"), true);
    assert.equal(ask("Turn these notes into a Word document"), true);
    assert.equal(ask("Create an Excel spreadsheet to track my budget"), true);
    assert.equal(ask("Can you make a PDF of my CV?"), true);
    assert.equal(ask("Plot this data as a bar chart"), true);
  });

  it("recognises the acceptance-test requests", () => {
    assert.equal(ask("Draft a cover letter and give me a PDF"), true);
    assert.equal(ask("Turn this data into a chart and an Excel file"), true);
    assert.equal(ask("Make a 10-slide presentation on renewable energy"), true);
    assert.equal(ask("Convert this Word document to PDF", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]), true);
  });

  it("recognises websites, code files and zips", () => {
    assert.equal(ask("Give me my portfolio as files"), true);
    assert.equal(ask("Build me a website with index.html, style.css and script.js"), true);
    assert.equal(ask("zip these up for me"), true);
    assert.equal(ask("Create a Python file that sorts my marks"), true);
  });

  it("runs code only when there is code to run", () => {
    assert.equal(ask("Run this code:\n```python\nprint(2**10)\n```"), true);
    assert.equal(ask("can you run my python script"), true);
    assert.equal(ask("How do I run a Python script on Windows?"), false);
    assert.equal(ask("What does a website need to load fast?"), false);
  });

  it("recognises image edits only when an image is attached", () => {
    assert.equal(ask("crop this and make it black and white", ["image/jpeg"]), true);
    assert.equal(ask("crop this and make it black and white"), false);
  });

  it("leaves ordinary questions alone", () => {
    assert.equal(ask("What is a PDF?"), false);
    assert.equal(ask("Explain photosynthesis"), false);
    assert.equal(ask("How do slides work in a presentation?"), false);
  });
});

describe("wantsVectorArt", () => {
  it("recognises logo and icon requests", () => {
    assert.equal(wantsVectorArt("Design a logo for my study group called Nova"), true);
    assert.equal(wantsVectorArt("make me an icon of a book"), true);
    assert.equal(wantsVectorArt("What makes a good logo?"), false);
  });
});

describe("wantsFileEdit", () => {
  it("recognises changes to a file just made", () => {
    assert.equal(wantsFileEdit("Make the title blue"), true);
    assert.equal(wantsFileEdit("add a slide on costs"), true);
    assert.equal(wantsFileEdit("change the colour to white"), true);
  });

  it("leaves thanks and unrelated questions alone", () => {
    assert.equal(wantsFileEdit("thanks, that's perfect"), false);
    assert.equal(wantsFileEdit("What is photosynthesis?"), false);
  });
});
