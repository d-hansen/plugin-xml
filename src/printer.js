import * as doc from "prettier/doc";
import embed from "./embed.js";

const {
  fill,
  group,
  hardline,
  indent,
  join,
  line,
  literalline,
  softline,
  ifBreak
} = doc.builders;

const ignoreStartComment = "<!-- prettier-ignore-start -->";
const ignoreEndComment = "<!-- prettier-ignore-end -->";

function sortedIndexOf(array, value, valueFn) {
  let lowIdx = 0,
    highIdx = array.length;
  // some shortcuts - value is before the beginning
  if (valueFn(array[lowIdx]) > value) return lowIdx;
  // value is after the end
  if (valueFn(array[highIdx - 1]) < value) return highIdx;
  while (lowIdx < highIdx) {
    let midIdx = (lowIdx + highIdx) >> 1;
    if (valueFn(array[midIdx]) < value) lowIdx = midIdx + 1;
    else highIdx = midIdx;
  }
  return lowIdx;
}

function hasIgnoreRanges(comments) {
  if (comments.length === 0) {
    return false;
  }

  comments.sort((left, right) => left.startOffset - right.startOffset);

  let startFound = false;
  for (let idx = 0; idx < comments.length; idx += 1) {
    if (comments[idx].image === ignoreStartComment) {
      startFound = true;
    } else if (startFound && comments[idx].image === ignoreEndComment) {
      return true;
    }
  }

  return false;
}

function isWhitespaceIgnorable(opts, name, attributes, content) {
  // If the whitespace sensitivity setting is "strict", then we can't ignore the
  // whitespace.
  if (opts.xmlWhitespaceSensitivity === "strict") {
    return false;
  }

  // If we have an xsl:text element, then we cannot ignore the whitespace.
  if (name === "xsl:text") {
    return false;
  }

  // If there is an xml:space attribute set to "preserve", then we can't ignore
  // the whitespace.
  if (
    attributes.some(
      (attribute) =>
        attribute &&
        attribute.Name === "xml:space" &&
        attribute.STRING.slice(1, -1) === "preserve"
    )
  ) {
    return false;
  }

  // If there are comments in the content and the comments are ignore ranges,
  // then we can't ignore the whitespace.
  if (hasIgnoreRanges(content.Comment)) {
    return false;
  }

  // Otherwise we can.
  return true;
}

function printIToken(path) {
  const node = path.getValue();

  return {
    offset: node.startOffset,
    startLine: node.startLine,
    endLine: node.endLine,
    printed: node.image
  };
}

function printAttribute(path, opts, print) {
  const { Name, EQUALS, STRING } = path.getValue();

  let attributeValue;
  if (opts.xmlQuoteAttributes === "double") {
    const content = STRING.slice(1, -1).replaceAll('"', "&quot;");
    attributeValue = `"${content}"`;
  } else if (opts.xmlQuoteAttributes === "single") {
    const content = STRING.slice(1, -1).replaceAll("'", "&apos;");
    attributeValue = `'${content}'`;
  } else {
    // preserve
    attributeValue = STRING;
  }

  return [Name, EQUALS, attributeValue];
}

function printCharData(path, opts, print) {
  const { SEA_WS, TEXT } = path.getValue();
  const image = SEA_WS || TEXT;

  return image
    .split(/(\n)/g)
    .map((value, index) => (index % 2 === 0 ? value : literalline));
}

function getCharDataFragments(path, opts, print, isContent) {
  let results = [];
  let prevLocation = null;
  let hasTextChildren = path.getValue().chardata.some((child) => !!child.TEXT);
  let preserveWhitespace =
    isContent ||
    (opts.xmlWhitespaceSensitivity === "preserve" && hasTextChildren);
  path.each((charDataPath) => {
    const chardata = charDataPath.getValue();
    const location = chardata.location;
    const response = {
      offset: location.startOffset,
      startLine: location.startLine,
      endLine: location.endLine,
      isCharData: true
    };
    if (preserveWhitespace) {
      response.printed = print(charDataPath);
      response.preserveWhitespace = true;
      if (
        prevLocation?.endColumn &&
        location.startColumn &&
        location.startLine === prevLocation.endLine &&
        location.startColumn === prevLocation.endColumn + 1
      ) {
        // continuation of previous fragment
        const prevFragment = results[results.length - 1];
        prevFragment.endLine = location.endLine;
        prevFragment.printed = group([prevFragment.printed, response.printed]);
        return;
      }
    } else if (!chardata.TEXT) {
      // Add a placeholder if this SEA_WS contained a newline.
      // This will be used to determine if a comment should stay on the same line or a new line
      response.isWhitespace = true;
      response.printed = chardata.SEA_WS;
      response.hasNewLine = chardata.SEA_WS.includes("\n");
    } else {
      //const content = chardata.TEXT.trim();
      const content = chardata.TEXT.replaceAll(
        /^[\t\n\r\s]+|[\t\n\r\s]+$/g,
        ""
      );
      response.printed = group(
        content
          .split(/(\n)/g)
          .map((value) =>
            value === "\n"
              ? literalline
              : fill(
                  value
                    .split(/\b(\s+)\b/g)
                    .map((segment, index) => (index % 2 === 0 ? segment : line))
                )
          )
      );
    }
    prevLocation = location;
    results.push(response);
  }, "chardata");
  return results;
}

function getFragments(path, opts, print, isContent = false) {
  let result = [
    ...path.map(
      (cDataPath) => Object.assign(printIToken(cDataPath), { isCData: true }),
      "CData"
    ),
    ...path.map(
      (commentPath) =>
        Object.assign(printIToken(commentPath), { isComment: true }),
      "Comment"
    ),
    ...getCharDataFragments(path, opts, print, isContent),
    ...path.map((elementPath) => {
      const element = elementPath.getValue();
      const location = element.location;
      return {
        offset: location.startOffset,
        printed: print(elementPath),
        startLine: location.startLine,
        endLine: location.endLine,
        isClosed: !!element.SLASH_OPEN || !!element.SLASH_CLOSE,
        isElement: true
      };
    }, "element"),
    ...path.map(printIToken, "PROCESSING_INSTRUCTION"),
    ...path.map((referencePath) => {
      const referenceNode = referencePath.getValue();
      return {
        offset: referenceNode.location.startOffset,
        printed: print(referencePath),
        isReference: true
      };
    }, "reference")
  ];
  result.sort((left, right) => left.offset - right.offset);
  return result;
}

function printContent(path, opts, print) {
  let fragments = getFragments(path, opts, print, true);
  const { Comment } = path.getValue();

  // Sort the order of comments now so we don't have to actually do it twice.
  // Note: sorting an already sorted array has no effect (since hasIgnoreRanges also sorts)
  // whereas having to actually sort the array twice is dumb.
  Comment.sort((left, right) => left.startOffset - right.startOffset);

  if (hasIgnoreRanges(Comment)) {
    const ignoreRanges = [];
    let ignoreStart = null;

    // Build up a list of ignored ranges from the original text based on
    // the special prettier-ignore-* comments
    Comment.forEach((comment) => {
      if (comment.image === ignoreStartComment) {
        ignoreStart = comment;
      } else if (ignoreStart && comment.image === ignoreEndComment) {
        ignoreRanges.push({
          start: ignoreStart.startOffset,
          end: comment.endOffset
        });

        ignoreStart = null;
      }
    });

    // Filter the printed fragments to only include the ones that are
    // outside of each of the ignored ranges
    fragments = fragments.filter(
      (fragment) =>
        !fragment.isWhitespace &&
        ignoreRanges.every(
          ({ start, end }) => fragment.offset < start || fragment.offset > end
        )
    );

    // Push each of the ignored ranges into the child list as its own
    // element so that the original content is still included
    ignoreRanges.forEach(({ start, end }) => {
      const content = opts.originalText.slice(start, end + 1);

      const idx = sortedIndexOf(
        fragments,
        start,
        (fragment) => fragment.offset
      );
      fragments.splice(idx, 0, {
        offset: start,
        printed: doc.utils.replaceEndOfLine(content)
      });
    });
  }

  return group(fragments.map(({ printed }) => printed));
}

function printDocTypeDecl(path, opts, print) {
  const { DocType, Name, externalID, CLOSE } = path.getValue();
  const parts = [DocType, " ", Name];

  if (externalID) {
    parts.push(" ", path.call(print, "externalID"));
  }

  return group([...parts, CLOSE]);
}

function printDocument(path, opts, print) {
  const { docTypeDecl, element, misc, prolog } = path.getValue();
  const fragments = [];

  if (docTypeDecl) {
    fragments.push({
      offset: docTypeDecl.location.startOffset,
      printed: path.call(print, "docTypeDecl")
    });
  }

  if (prolog) {
    fragments.push({
      offset: prolog.location.startOffset,
      printed: path.call(print, "prolog")
    });
  }

  path.each((miscPath) => {
    const misc = miscPath.getValue();

    fragments.push({
      offset: misc.location.startOffset,
      printed: print(miscPath)
    });
  }, "misc");

  if (element) {
    fragments.push({
      offset: element.location.startOffset,
      printed: path.call(print, "element")
    });
  }

  fragments.sort((left, right) => left.offset - right.offset);

  return [
    join(
      hardline,
      fragments.map(({ printed }) => printed)
    ),
    hardline
  ];
}

function printElement(path, opts, print) {
  const {
    OPEN,
    Name,
    attribute,
    START_CLOSE,
    content,
    SLASH_OPEN,
    END_NAME,
    END,
    SLASH_CLOSE
  } = path.getValue();

  const parts = [OPEN, Name];

  if (attribute.length > 0) {
    const attributes = path.map(
      (attributePath) => ({
        node: attributePath.getValue(),
        printed: print(attributePath)
      }),
      "attribute"
    );

    if (opts.xmlSortAttributesByKey) {
      attributes.sort((left, right) => {
        const leftAttr = left.node.Name;
        const rightAttr = right.node.Name;

        // Check if the attributes are xmlns.
        if (leftAttr === "xmlns") return -1;
        if (rightAttr === "xmlns") return 1;

        // Check if they are both in namespaces.
        if (leftAttr.includes(":") && rightAttr.includes(":")) {
          const [leftNS, leftKey] = leftAttr.split(":");
          const [rightNS, rightKey] = rightAttr.split(":");

          // If namespaces are equal, compare keys
          if (leftNS === rightNS) return leftKey.localeCompare(rightKey);

          // Handle the 1 but not both being an xmlns
          if (leftNS === "xmlns") return -1;
          if (rightNS === "xmlns") return 1;

          return leftNS.localeCompare(rightNS);
        }

        // Check if the attributes have namespaces.
        if (leftAttr.includes(":")) return -1;
        if (rightAttr.includes(":")) return 1;

        return leftAttr.localeCompare(rightAttr);
      });
    }

    const separator = opts.singleAttributePerLine ? hardline : line;
    parts.push(
      indent([
        line,
        join(
          separator,
          attributes.map(({ printed }) => printed)
        )
      ])
    );
  }

  // Determine the value that will go between the <, name, and attributes
  // of an element and the /> of an element.
  let space;
  if (opts.bracketSameLine) {
    space = opts.xmlSelfClosingSpace ? " " : "";
  } else {
    space = opts.xmlSelfClosingSpace ? line : softline;
  }

  if (SLASH_CLOSE) {
    return group([...parts, space, SLASH_CLOSE]);
  }

  if (
    content.chardata.length === 0 &&
    content.CData.length === 0 &&
    content.Comment.length === 0 &&
    content.element.length === 0 &&
    content.PROCESSING_INSTRUCTION.length === 0 &&
    content.reference.length === 0
  ) {
    return group([...parts, space, "/>"]);
  }

  var openTag = group([
    ...parts,
    opts.bracketSameLine ? "" : softline,
    START_CLOSE
  ]);

  const closeTag = group([SLASH_OPEN, END_NAME, END]);

  if (isWhitespaceIgnorable(opts, Name, attribute, content)) {
    const allFragments = path.call(
      (childPath) => getFragments(childPath, opts, print, false),
      "content"
    );

    const itemFragments = allFragments.filter(
      (fragment) => !fragment.isWhitespace
    );

    if (
      opts.xmlWhitespaceSensitivity === "preserve" &&
      allFragments.some(({ preserveWhitespace }) => preserveWhitespace)
    ) {
      return group([
        openTag,
        allFragments.map(({ printed }) => printed),
        closeTag
      ]);
    }

    if (itemFragments.length === 0) {
      return group([...parts, space, "/>"]);
    }

    // Determine the number of text (non-whitespace) chardata fragments
    let charDataFragCount = content.chardata.filter(
      (charData) => !!charData.TEXT
    ).length;

    // If the only content of this tag is chardata, then use a softline so
    // that we won't necessarily break (to allow <foo>bar</foo>).
    if (itemFragments.length === 1 && charDataFragCount === 1) {
      return group([
        openTag,
        indent([softline, itemFragments[0].printed]),
        softline,
        closeTag
      ]);
    }

    const docs = [];
    let prevFragment = null;
    let prevDocFragment = null;

    allFragments.forEach((fragment) => {
      if (!fragment.isWhitespace) {
        const prevDocItem = docs[docs.length - 1];
        const delim = prevFragment?.isWhitespace ? line : softline;
        if (
          prevDocFragment &&
          fragment.startLine - prevDocFragment.endLine >= 2
        ) {
          // If we skipped multiple lines, just output this fragment after an extra blank line
          docs.push(hardline, hardline, fragment.printed);
        } else if (fragment.isComment) {
          // Node is a comment, determine whether to preserve previous whitespace
          if (prevFragment?.isWhitespace && prevFragment.hasNewLine) {
            docs.push(hardline, fragment.printed);
          } else if (!prevDocFragment) {
            // First comment after an opening tag (but potentially after some whitespace):
            // We'll add the comment onto end of opening tag in an attempt to keep it with that tag
            // This is tricky though, if we need to break because of the comment, then we want to
            // control where the break happens, preferably between the close brace and the comment.
            // If the comment needs to break, then we actually want to indent the comment as it
            // technically is a child of the element, so we use ifBreak to control this.
            let cPrinted = [delim, fragment.printed];
            openTag.contents.push(ifBreak(group(indent(cPrinted)), cPrinted));
          } else if (prevDocItem?.contents?.parts) {
            // Previous doc entry is already a group, just append the comment to the previous group
            prevDocItem.contents.parts.push(delim, fragment.printed);
          } else if (prevDocFragment?.isElement && !prevDocFragment.isClosed) {
            // Turn the last doc entry into a group and append the comment
            docs[docs.length - 1] = group([
              prevDocItem,
              delim,
              fragment.printed
            ]);
          } else {
            let printed = [delim, fragment.printed];
            docs.push(group(printed));
          }
        } else if (
          (fragment.isReference &&
            (prevDocFragment?.isCharData || prevDocFragment?.isReference)) ||
          (fragment.isCharData && prevDocFragment?.isReference)
        ) {
          // Merge this fragment onto the last docs's group parts
          if (prevDocItem?.contents?.parts) {
            prevDocItem.contents.parts.push(delim, fragment.printed);
          } else {
            docs.push(group(fill([delim, fragment.printed])));
          }
        } else {
          docs.push(hardline, fragment.printed);
        }
        prevDocFragment = fragment;
      }
      prevFragment = fragment;
    });

    return group([openTag, indent(docs), hardline, closeTag]);
  }

  return group([openTag, indent(path.call(print, "content")), closeTag]);
}

function printExternalID(path, opts, print) {
  const { Public, PubIDLiteral, System, SystemLiteral } = path.getValue();

  if (System) {
    return group([System, indent([line, SystemLiteral])]);
  }

  return group([
    group([Public, indent([line, PubIDLiteral])]),
    indent([line, SystemLiteral])
  ]);
}

function printMisc(path, opts, print) {
  const { Comment, PROCESSING_INSTRUCTION, SEA_WS } = path.getValue();

  return Comment || PROCESSING_INSTRUCTION || SEA_WS;
}

function printProlog(path, opts, print) {
  const { XMLDeclOpen, attribute, SPECIAL_CLOSE } = path.getValue();
  const parts = [XMLDeclOpen];

  if (attribute) {
    parts.push(indent([softline, join(line, path.map(print, "attribute"))]));
  }

  return group([
    ...parts,
    opts.xmlSelfClosingSpace ? line : softline,
    SPECIAL_CLOSE
  ]);
}

function printReference(path, opts, print) {
  const { CharRef, EntityRef } = path.getValue();

  return CharRef || EntityRef;
}

const printer = {
  getVisitorKeys(node, nonTraversableKeys) {
    return Object.keys(node).filter(
      (key) => key !== "location" && key !== "tokenType"
    );
  },
  embed,
  print(path, opts, print) {
    const node = path.getValue();

    switch (node.name) {
      case "attribute":
        return printAttribute(path, opts, print);
      case "chardata":
        return printCharData(path, opts, print);
      case "content":
        return printContent(path, opts, print);
      case "docTypeDecl":
        return printDocTypeDecl(path, opts, print);
      case "document":
        return printDocument(path, opts, print);
      case "element":
        return printElement(path, opts, print);
      case "externalID":
        return printExternalID(path, opts, print);
      case "misc":
        return printMisc(path, opts, print);
      case "prolog":
        return printProlog(path, opts, print);
      case "reference":
        return printReference(path, opts, print);
      default:
        throw new Error(`Unknown node type: ${node.name}`);
    }
  }
};

export default printer;
