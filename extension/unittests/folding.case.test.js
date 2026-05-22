const assert = require('assert');
const path = require('path');
const { computeFoldingRanges } = require(path.join('..', 'src', 'folding.ts'));

describe('Folding: CASE inside ON ACTION', function() {
  it('preserves the CASE folding range and also exposes an outer ON ACTION fold', function() {
    const src = [
      'ON ACTION CONTROLP',
      '    CASE',
      '        WHEN INFIELD(zx01)',
      '            CALL cl_init_qry_var()',
      '            LET g_qryparam.form ="q_zx"',
      '',
      '        WHEN INFIELD(zx03)',
      '            CALL cl_init_qry_var()',
      '            LET g_qryparam.form ="q_gem"',
      '    END CASE'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:8:code'), `expected CASE folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:9:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves the CASE folding range inside ON MENU and also exposes the outer ON MENU fold', function() {
    const src = [
      'MENU "demo"',
      '    ON MENU find',
      '        CASE',
      '            WHEN ok',
      '                CALL run_find()',
      '            WHEN retry',
      '                CALL run_retry()',
      '        END CASE',
      'END MENU'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('2:6:code'), `expected CASE folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('1:7:code'), `expected outer ON MENU folding range, got ${serialized.join(', ')}`);
  });

  it('still creates indent folds for normal nested statements when the next line is not structural', function() {
    const src = [
      'ON ACTION CONTROLP',
      '    LET mode = "A"',
      '        CALL prepare_mode()',
      '    DISPLAY mode TO zx01'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:2:code'), `expected normal indent folding range, got ${serialized.join(', ')}`);
  });

  it('keeps pure indent folds open across blank lines until the next indent boundary', function() {
    const src = [
      'ON ACTION CONTROLP',
      '    LET mode = "A"',
      '        CALL prepare_mode()',
      '',
      '    DISPLAY mode TO zx01'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:3:code'), `expected inner indent folding range to continue across blank line, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:4:code'), `expected ON ACTION fold to remain open until the next indent boundary, got ${serialized.join(', ')}`);
  });

  it('preserves the INPUT folding range and also exposes the outer action fold', function() {
    const src = [
      'ON ACTION edit_data',
      '    INPUT BY NAME customer.*',
      '        BEFORE FIELD cust_name',
      '            CALL init_name()',
      '        AFTER FIELD cust_name',
      '            CALL validate_name()',
      '    END INPUT'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:5:code'), `expected INPUT folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:6:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves the CONSTRUCT folding range and also exposes the outer action fold', function() {
    const src = [
      'ON ACTION query_data',
      '    CONSTRUCT BY NAME qry.*',
      '        BEFORE CONSTRUCT',
      '            CALL init_query()',
      '        ON KEY(F5)',
      '            CALL assist_query()',
      '    END CONSTRUCT'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:5:code'), `expected CONSTRUCT folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:6:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves the DISPLAY ARRAY folding range and also exposes the outer action fold', function() {
    const src = [
      'ON ACTION browse_data',
      '    DISPLAY ARRAY arr TO sr.*',
      '        BEFORE ROW',
      '            CALL load_row()',
      '        AFTER ROW',
      '            CALL save_row()',
      '    END DISPLAY'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:5:code'), `expected DISPLAY ARRAY folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:6:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves the SELECT folding range and also exposes the outer action fold', function() {
    const src = [
      'ON ACTION load_data',
      '    SELECT *',
      '        FROM customer',
      '        WHERE active = 1',
      '        INTO rec.*',
      '    END SELECT'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:4:code'), `expected SELECT folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:5:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves the LOOP folding range and also exposes the outer action fold', function() {
    const src = [
      'ON ACTION process_data',
      '    LOOP',
      '        CALL fetch_next()',
      '        IF done THEN',
      '            EXIT LOOP',
      '        END IF',
      '    END LOOP'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('1:5:code'), `expected LOOP folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('0:6:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
  });

  it('preserves both ON ACTION and CASE folds for the reported controlp sample', function() {
    const src = [
      'ON ACTION controlp -->換成這裡折疊不見了',
      '            CASE',
      '                WHEN INFIELD(tc_cxx01)',
      '                    CALL cl_init_qry_var()',
      '                    LET g_qryparam.form = "q_cxx"',
      '                    LET g_qryparam.state = "c"',
      '                    LET g_qryparam.default1 = g_cxx.tc_cxx01',
      '                    CALL cl_create_qry() RETURNING g_qryparam.multiret',
      '                    DISPLAY g_qryparam.multiret TO tc_cxx01',
      '                    NEXT FIELD tc_cxx01',
      '',
      '                OTHERWISE',
      '                    EXIT CASE',
      '            END CASE'
    ];

    const ranges = computeFoldingRanges(src);
    const serialized = ranges.map(range => `${range.start}:${range.end}:${range.kind || 'code'}`);

    assert.ok(serialized.includes('0:13:code'), `expected outer ON ACTION folding range, got ${serialized.join(', ')}`);
    assert.ok(serialized.includes('1:12:code'), `expected CASE folding range, got ${serialized.join(', ')}`);
  });
});